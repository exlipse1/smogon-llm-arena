import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {loadDotEnv} from '../src/core/env.js';
import {readJson, writeJson} from '../src/core/fs.js';
import {fromRoot} from '../src/core/paths.js';
import {activePlayers, selectedPlayers} from '../src/core/manifest.js';

await loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest ?? 'config/ladder.openai.example.json';
const attempts = String(args.attempts ?? 3);
const force = Boolean(args.force);
const dryRun = Boolean(args.dryRun ?? args['dry-run']);
const manifest = await readJson(manifestPath);
const selectedIds = new Set(String(args.players ?? '').split(',').map(value => value.trim()).filter(Boolean));
const players = selectedPlayers(activePlayers(manifest), selectedIds)
  .filter(player => player.type === 'openai');
let manifestChanged = false;

if (!process.env.OPENAI_API_KEY && !dryRun) {
  throw new Error('OPENAI_API_KEY is required to build OpenAI roster teams.');
}

for (const player of players) {
  const teamPath = fromRoot(player.teamFile);
  const exists = await fileExists(teamPath);
  if (exists && !force) {
    console.log(JSON.stringify({player: player.id, model: player.model, teamFile: player.teamFile, skipped: 'exists'}));
    continue;
  }

  const command = [
    process.execPath,
    'src/cli.js',
    'build-team',
    '--model',
    player.model,
    '--out',
    player.teamFile,
    '--attempts',
    attempts,
  ];
  const reasoningEffort = player.reasoningEffort ?? player.reasoning?.effort;
  if (reasoningEffort) command.push('--reasoning-effort', reasoningEffort);
  if (dryRun) {
    console.log(JSON.stringify({player: player.id, model: player.model, reasoningEffort: reasoningEffort ?? null, command}));
    continue;
  }

  console.log(`Building ${player.id} team with ${player.model}${reasoningEffort ? ` (${reasoningEffort} reasoning)` : ''}...`);
  await run(command);
  player.teamSource = 'openai-generated';
  player.teamGeneratedAt = new Date().toISOString();
  manifestChanged = true;
}

if (manifestChanged) await writeJson(manifestPath, manifest);

function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: fromRoot(),
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
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
