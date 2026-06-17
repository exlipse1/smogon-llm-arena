#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {loadDotEnv} from '../src/core/env.js';
import {fromRoot} from '../src/core/paths.js';
import {auditBenchmarkReadiness} from '../src/readiness.js';

await loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest ?? 'config/ladder.openai.example.json';
const matchesDir = args.matchesDir ?? args['matches-dir'] ?? 'results/live-ladder';
const statusDir = args.statusDir ?? args['status-dir'] ?? `${matchesDir}/status`;
const sitePath = args.site ?? args['site-path'] ?? 'site/leaderboard.json';
const publishIntervalMs = String(args.publishIntervalMs ?? args['publish-interval-ms'] ?? 30_000);
const restartDelayMs = String(args.restartDelayMs ?? args['restart-delay-ms'] ?? 20_000);
const pollRatings = booleanArg(args, 'pollRatings', 'poll-ratings', true);
const start = booleanArg(args, 'start', 'start', false);
const strict = booleanArg(args, 'strict', 'strict', false);
const requireLogs = booleanArg(args, 'requireLogs', 'require-logs', false);
const requireExternalSite = booleanArg(args, 'requireExternalSite', 'require-external-site', false);
const requirePublicRatings = booleanArg(args, 'requirePublicRatings', 'require-public-ratings', false);
const seasonId = args.seasonId ?? args['season-id'];
const seasonName = args.seasonName ?? args['season-name'];
const seasonStartedAt = args.seasonStartedAt ?? args['season-started-at'];
const archiveDir = args.archiveDir ?? args['archive-dir'];

const report = await auditBenchmarkReadiness({
  manifestPath,
  matchesDir,
  statusDir,
  sitePath,
  pollRatings,
  usersBaseUrl: args.usersBaseUrl ?? args['users-base-url'],
  externalUrl: args.externalUrl ?? args['external-url'],
});

const launchGateNames = new Set([
  'freeze',
  'manifestPlayers',
  'teams',
  'teamPolicy',
  'modelApiKeys',
  'credentials',
  'sitePayload',
]);
if (requireLogs) launchGateNames.add('logs');
if (requireExternalSite) launchGateNames.add('externalSite');
if (requirePublicRatings) launchGateNames.add('publicRatings');

const gateChecks = report.checks.filter(check => launchGateNames.has(check.name));
const launchReady = gateChecks.every(check => check.ok);
const rosterCommand = buildRosterCommand();

const activation = {
  ok: launchReady,
  status: launchReady ? (start ? 'starting' : 'ready-to-start') : 'waiting-for-operator-input',
  manifestPath,
  matchesDir,
  sitePath,
  season: {
    id: seasonId ?? report.season?.id ?? null,
    name: seasonName ?? report.season?.name ?? null,
    startedAt: seasonStartedAt ?? report.season?.startedAt ?? null,
    archiveDir: archiveDir ?? report.season?.archiveDir ?? null,
  },
  launchGate: gateChecks.map(({name, ok, problems}) => ({name, ok, problems})),
  warnings: report.checks
    .filter(check => !launchGateNames.has(check.name) && !check.ok)
    .map(({name, problems}) => ({name, problems})),
  missingInputs: missingInputs(report),
  launchCommand: rosterCommand.map(shellArg).join(' '),
  players: report.players.map(player => ({
    id: player.id,
    model: player.model,
    teamValid: player.team.valid,
    apiKeyEnv: player.modelApi.apiKeyEnv,
    hasApiKey: player.modelApi.hasApiKey,
    usernameEnv: player.account.usernameEnv,
    hasUsername: player.account.hasUsername,
    passwordEnv: player.account.passwordEnv,
    hasPassword: player.account.hasPassword,
    ready: player.ready,
  })),
};

console.log(JSON.stringify(activation, null, 2));

if (!launchReady) {
  if (strict || start) process.exitCode = 1;
} else if (start) {
  await runRoster(rosterCommand);
}

function buildRosterCommand() {
  const command = [
    process.execPath,
    'scripts/run-live-roster.mjs',
    '--manifest',
    manifestPath,
    '--matches-dir',
    matchesDir,
    '--status-dir',
    statusDir,
    '--site',
    sitePath,
    '--publish-interval-ms',
    publishIntervalMs,
    '--restart-delay-ms',
    restartDelayMs,
  ];
  if (pollRatings) command.push('--poll-ratings');
  else command.push('--poll-ratings', 'false');
  if (args.usersBaseUrl ?? args['users-base-url']) {
    command.push('--users-base-url', args.usersBaseUrl ?? args['users-base-url']);
  }
  if (seasonId) command.push('--season-id', seasonId);
  if (seasonName) command.push('--season-name', seasonName);
  if (seasonStartedAt) command.push('--season-started-at', seasonStartedAt);
  if (archiveDir) command.push('--archive-dir', archiveDir);
  if (args.games) {
    command.push('--continuous', 'false', '--games', String(args.games));
  } else {
    command.push('--continuous');
  }
  return command;
}

function runRoster(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: fromRoot(),
      env: process.env,
      stdio: 'inherit',
    });
    child.on('exit', code => {
      process.exitCode = code ?? 1;
      resolve();
    });
    child.on('error', reject);
  });
}

function missingInputs(report) {
  const problems = [];
  for (const check of report.checks) {
    if (check.ok) continue;
    if (check.name === 'modelApiKeys') {
      problems.push(...check.problems.map(problem => ({
        type: 'openai-api-key',
        problem,
      })));
    }
    if (check.name === 'credentials') {
      problems.push(...check.problems.map(problem => ({
        type: 'pokemon-showdown-account',
        problem,
      })));
    }
    if (check.name === 'teamPolicy') {
      problems.push(...check.problems.map(problem => ({
        type: 'team-generation',
        problem,
      })));
    }
  }
  return problems;
}

function booleanArg(parsed, camelName, kebabName, defaultValue) {
  const value = parsed[camelName] ?? parsed[kebabName];
  if (value === undefined) return defaultValue;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  return Boolean(value);
}

function shellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
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
