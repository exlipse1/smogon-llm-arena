#!/usr/bin/env node
import {loadDotEnv} from '../src/core/env.js';
import {readJson} from '../src/core/fs.js';
import {activePlayers, selectedPlayers} from '../src/core/manifest.js';
import {verifyShowdownLogin} from '../src/showdown/live-ladder.js';

await loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest ?? 'config/ladder.openai.example.json';
const manifest = await readJson(manifestPath);
const selectedIds = new Set(String(args.players ?? '').split(',').map(value => value.trim()).filter(Boolean));
const players = selectedPlayers(activePlayers(manifest), selectedIds)
  .filter(player => player.showdownAccount ?? player.account);
const results = [];

for (const player of players) {
  const account = player.showdownAccount ?? player.account ?? {};
  const username = account.username ?? (account.usernameEnv ? process.env[account.usernameEnv] : null);
  const password = account.password ?? (account.passwordEnv ? process.env[account.passwordEnv] : null);
  if (!username || !password) {
    results.push({
      player: player.id,
      ok: false,
      usernameEnv: account.usernameEnv ?? null,
      passwordEnv: account.passwordEnv ?? null,
      error: `Missing ${!username ? account.usernameEnv ?? 'username' : account.passwordEnv ?? 'password'}.`,
    });
    continue;
  }
  try {
    const login = await verifyShowdownLogin({
      username,
      password,
      serverUrl: args.server ?? args['server-url'],
      loginUrl: args.loginUrl ?? args['login-url'],
      timeoutMs: Number(args.timeoutMs ?? args['timeout-ms'] ?? 15_000),
    });
    results.push({
      player: player.id,
      ok: true,
      username: login.username,
      userId: login.userId,
    });
  } catch (error) {
    results.push({
      player: player.id,
      ok: false,
      username,
      error: String(error?.message ?? error),
    });
  }
}

const summary = {
  ok: results.every(result => result.ok),
  checked: results.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;

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
