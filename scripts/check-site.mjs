import fs from 'node:fs/promises';
import {fromRoot} from '../src/core/paths.js';

const requiredFiles = [
  'site/index.html',
  'site/app.js',
  'site/styles.css',
  'site/leaderboard.json',
];

const problems = [];
for (const file of requiredFiles) {
  try {
    await fs.access(fromRoot(file));
  } catch (error) {
    if (error?.code === 'ENOENT') problems.push(`Missing ${file}`);
    else throw error;
  }
}

let leaderboard = null;
if (!problems.some(problem => problem.includes('site/leaderboard.json'))) {
  leaderboard = JSON.parse(await fs.readFile(fromRoot('site/leaderboard.json'), 'utf8'));
  if (!leaderboard.generatedAt) problems.push('leaderboard.json is missing generatedAt.');
  if (!leaderboard.season?.id) problems.push('leaderboard.json is missing season.id.');
  if (!leaderboard.formatId) problems.push('leaderboard.json is missing formatId.');
  if (!Array.isArray(leaderboard.players)) problems.push('leaderboard.json players must be an array.');
  if (!leaderboard.health) problems.push('leaderboard.json is missing health metadata.');
  for (const player of leaderboard.players ?? []) {
    if (!Number.isFinite(Number(player.rating))) problems.push(`${player.id ?? 'player'} is missing rating.`);
    if (!Array.isArray(player.ratingHistory)) problems.push(`${player.id ?? 'player'} is missing ratingHistory.`);
  }
  if (leaderboard.artifacts?.archivePath) {
    try {
      await fs.access(fromRoot(leaderboard.artifacts.archivePath));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        problems.push(`Archived season payload is missing: ${leaderboard.artifacts.archivePath}`);
      } else {
        throw error;
      }
    }
  }
}

const index = await fs.readFile(fromRoot('site/index.html'), 'utf8').catch(() => '');
if (index && !index.includes('./app.js')) problems.push('index.html does not reference app.js.');
if (index && !index.includes('./styles.css')) problems.push('index.html does not reference styles.css.');

const result = {
  ok: problems.length === 0,
  files: requiredFiles,
  players: leaderboard?.players?.length ?? 0,
  totalGames: leaderboard?.totalGames ?? 0,
  health: leaderboard?.health?.state ?? null,
  problems,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
