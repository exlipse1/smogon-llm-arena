import {spawn} from 'node:child_process';
import {fromRoot} from '../src/core/paths.js';

const node = process.execPath;
const checks = [
  ['syntax:cli', [node, '--check', 'src/cli.js']],
  ['syntax:live-results', [node, '--check', 'src/live-results.js']],
  ['syntax:live-ladder', [node, '--check', 'src/showdown/live-ladder.js']],
  ['syntax:readiness', [node, '--check', 'src/readiness.js']],
  ['syntax:activation', [node, '--check', 'scripts/activate-live-benchmark.mjs']],
  ['syntax:start-live', [node, '--check', 'scripts/start-live-benchmark.mjs']],
  ['syntax:check-showdown-logins', [node, '--check', 'scripts/check-showdown-logins.mjs']],
  ['syntax:check-openai-model-access', [node, '--check', 'scripts/check-openai-model-access.mjs']],
  ['openai-agent', [node, 'test/openai-agent.mjs']],
  ['smoke', [node, 'test/smoke.mjs']],
  ['live-ladder-mock', [node, 'test/live-ladder-mock.mjs']],
  ['doctor', [node, 'src/cli.js', 'doctor', '--manifest', 'config/ladder.openai.example.json', '--matches-dir', 'results/test-live', '--site', 'site/leaderboard.json']],
  ['activation-preflight', [node, 'scripts/activate-live-benchmark.mjs', '--manifest', 'config/ladder.openai.example.json', '--matches-dir', 'results/test-live', '--site', 'site/leaderboard.json', '--poll-ratings', 'false']],
  ['roster-dry-run', [node, 'scripts/run-live-roster.mjs', '--manifest', 'config/ladder.openai.example.json', '--dry-run']],
  ['team-build-dry-run', [node, 'scripts/build-openai-roster-teams.mjs', '--manifest', 'config/ladder.openai.example.json', '--dry-run']],
  ['publish-live-site', [node, 'src/cli.js', 'publish-live', '--manifest', 'config/ladder.openai.example.json', '--matches-dir', 'results/test-live', '--site', 'site/leaderboard.json', '--archive-dir', 'site/seasons']],
  ['site-check', [node, 'scripts/check-site.mjs']],
];

const results = [];
for (const [name, command] of checks) {
  const result = await run(command);
  results.push({name, ok: result.code === 0, code: result.code});
  if (result.code !== 0) {
    console.error(result.stderr || result.stdout);
    process.exitCode = result.code;
    break;
  }
}

console.log(JSON.stringify({
  ok: results.every(result => result.ok),
  checks: results,
}, null, 2));

function run(command) {
  return new Promise(resolve => {
    const child = spawn(command[0], command.slice(1), {
      cwd: fromRoot(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('exit', code => {
      resolve({code, stdout, stderr});
    });
    child.on('error', error => {
      resolve({code: 1, stdout, stderr: String(error?.stack ?? error)});
    });
  });
}
