#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fromRoot} from '../src/core/paths.js';

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest ?? 'config/ladder.openai.example.json';
const matchesDir = args.matchesDir ?? args['matches-dir'] ?? 'results/live-ladder';
const statusDir = args.statusDir ?? args['status-dir'] ?? `${matchesDir}/status`;
const sitePath = args.site ?? args['site-path'] ?? 'site/leaderboard.json';
const logPath = args.log ?? `${matchesDir}/runner.log`;
const pidPath = args.pid ?? `${matchesDir}/runner.pid`;
const publishIntervalMs = String(args.publishIntervalMs ?? args['publish-interval-ms'] ?? 30_000);
const pollRatings = args.pollRatings ?? args['poll-ratings'] ?? 'true';

await fsp.mkdir(fromRoot(matchesDir), {recursive: true});
await fsp.mkdir(path.dirname(fromRoot(logPath)), {recursive: true});

const out = fs.openSync(fromRoot(logPath), 'a');
const command = [
  process.execPath,
  'scripts/activate-live-benchmark.mjs',
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
  '--poll-ratings',
  String(pollRatings),
  '--start',
];

const child = spawn(command[0], command.slice(1), {
  cwd: fromRoot(),
  env: process.env,
  detached: true,
  stdio: ['ignore', out, out],
});
child.unref();
await fsp.writeFile(fromRoot(pidPath), `${child.pid}\n`);

console.log(JSON.stringify({
  ok: true,
  pid: child.pid,
  pidPath,
  logPath,
  command: command.join(' '),
}, null, 2));

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
