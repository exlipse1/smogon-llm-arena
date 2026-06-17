import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {loadDotEnv} from '../src/core/env.js';
import {readJson} from '../src/core/fs.js';
import {fromRoot} from '../src/core/paths.js';
import {activePlayers, selectedPlayers} from '../src/core/manifest.js';

await loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest ?? 'config/ladder.openai.example.json';
const matchesDir = args.matchesDir ?? args['matches-dir'] ?? 'results/live-ladder';
const statusDir = args.statusDir ?? args['status-dir'] ?? `${matchesDir}/status`;
const siteOut = args.site ?? args['site-out'] ?? 'site/leaderboard.json';
const publishIntervalMs = Number(args.publishIntervalMs ?? args['publish-interval-ms'] ?? 30_000);
const restartDelayMs = Number(args.restartDelayMs ?? args['restart-delay-ms'] ?? 20_000);
const pollRatings = args.pollRatings !== false &&
  args['poll-ratings'] !== false &&
  args.pollRatings !== 'false' &&
  args['poll-ratings'] !== 'false';
const seasonId = args.seasonId ?? args['season-id'];
const seasonName = args.seasonName ?? args['season-name'];
const seasonStartedAt = args.seasonStartedAt ?? args['season-started-at'];
const archiveDir = args.archiveDir ?? args['archive-dir'];
const games = args.games ? String(args.games) : null;
const continuous = args.continuous !== false && args.continuous !== 'false';
const dryRun = Boolean(args.dryRun ?? args['dry-run']);
const selectedIds = new Set(String(args.players ?? '').split(',').map(value => value.trim()).filter(Boolean));
const AGENT_DECISION_FAILURE_EXIT_CODE = 75;
const manifest = await readJson(manifestPath);
const players = selectedPlayers(activePlayers(manifest), selectedIds)
  .filter(player => player.runEnabled !== false);

if (!players.length) throw new Error('No roster players selected.');

const readiness = [];
for (const player of players) {
  readiness.push(await checkPlayer(player));
}

if (dryRun) {
  console.log(JSON.stringify({
    manifestPath,
    matchesDir,
    siteOut,
    pollRatings,
    players: readiness,
    publishCommand: publishCommand(),
  }, null, 2));
  process.exit(0);
}

const runnable = readiness.filter(entry => entry.ready);
if (!runnable.length) {
  console.error(JSON.stringify({ok: false, reason: 'No selected players have both credentials and team files.', players: readiness}, null, 2));
  process.exit(1);
}

await fs.mkdir(fromRoot(matchesDir), {recursive: true});
const children = new Map();
let stopping = false;

for (const entry of runnable) startBot(entry.player);

const publishTimer = setInterval(() => {
  publish().catch(error => console.error(`[publish] ${error?.stack ?? error}`));
}, publishIntervalMs);
await publish();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function startBot(player) {
  const command = [
    process.execPath,
    'src/cli.js',
    'live-ladder',
    '--manifest',
    manifestPath,
    '--player',
    player.id,
    '--matches',
    `${matchesDir}/${player.id}.jsonl`,
    '--status',
    `${statusDir}/${player.id}.json`,
  ];
  if (continuous) command.push('--continuous');
  else command.push('--games', games ?? '1');

  console.log(`[${player.id}] starting live ladder bot`);
  const child = spawn(command[0], command.slice(1), {
    cwd: fromRoot(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(player.id, child);
  pipeWithPrefix(child.stdout, `[${player.id}]`);
  pipeWithPrefix(child.stderr, `[${player.id} err]`);
  child.on('exit', code => {
    children.delete(player.id);
    console.log(`[${player.id}] exited with code ${code}`);
    if (code === AGENT_DECISION_FAILURE_EXIT_CODE) {
      console.log(`[${player.id}] not restarting after agent decision/API failure`);
      return;
    }
    if (!stopping && continuous) {
      setTimeout(() => startBot(player), restartDelayMs);
    }
  });
}

function publish() {
  return new Promise((resolve, reject) => {
    const command = publishCommand();
    const child = spawn(command[0], command.slice(1), {
      cwd: fromRoot(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeWithPrefix(child.stdout, '[publish]');
    pipeWithPrefix(child.stderr, '[publish err]');
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`publish-live exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function publishCommand() {
  const command = [
    process.execPath,
    'src/cli.js',
    'publish-live',
    '--manifest',
    manifestPath,
    '--matches-dir',
    matchesDir,
    '--site',
    siteOut,
    '--status-dir',
    statusDir,
  ];
  if (pollRatings) command.push('--poll-ratings');
  if (args.usersBaseUrl ?? args['users-base-url']) {
    command.push('--users-base-url', args.usersBaseUrl ?? args['users-base-url']);
  }
  if (seasonId) command.push('--season-id', seasonId);
  if (seasonName) command.push('--season-name', seasonName);
  if (seasonStartedAt) command.push('--season-started-at', seasonStartedAt);
  if (archiveDir) command.push('--archive-dir', archiveDir);
  return command;
}

async function checkPlayer(player) {
  const account = player.showdownAccount ?? player.account ?? {};
  const username = account.username ?? (account.usernameEnv ? process.env[account.usernameEnv] : null);
  const password = account.password ?? (account.passwordEnv ? process.env[account.passwordEnv] : null);
  const teamExists = await fileExists(fromRoot(player.teamFile));
  const summary = {
    id: player.id,
    model: player.model ?? null,
    teamFile: player.teamFile,
    usernameEnv: account.usernameEnv ?? null,
    passwordEnv: account.passwordEnv ?? null,
    hasUsername: Boolean(username),
    hasPassword: Boolean(password),
    teamExists,
    ready: Boolean(username && password && teamExists),
  };
  Object.defineProperty(summary, 'player', {value: player, enumerable: false});
  return summary;
}

async function fileExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function pipeWithPrefix(stream, prefix) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line) console.log(`${prefix} ${line}`);
    }
  });
}

function shutdown() {
  stopping = true;
  clearInterval(publishTimer);
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1_500);
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = rawArgs[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}
