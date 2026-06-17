import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {checkFreeze, loadFreeze} from '../src/showdown/freeze.js';
import {validateTeam} from '../src/showdown/teams.js';
import {readTextMaybeRoot} from '../src/core/fs.js';
import {runTournament} from '../src/tournament.js';
import {runLadder} from '../src/ladder.js';
import {publishLiveLeaderboard} from '../src/live-results.js';
import {writeText} from '../src/core/fs.js';
import {auditBenchmarkReadiness} from '../src/readiness.js';
import {fromRoot} from '../src/core/paths.js';
import {isLegalChoice, legalChoicesFromRequest, sanitizeRequestForPrompt} from '../src/core/choices.js';

const freezeCheck = await checkFreeze();
assert.equal(freezeCheck.ok, true, freezeCheck.problems.join('\n'));

const specialChoiceRequest = {
  active: [{
    moves: [
      {move: 'Fake Out', id: 'fakeout', pp: 16, maxpp: 16, target: 'normal'},
      {move: 'Close Combat', id: 'closecombat', pp: 8, maxpp: 8, target: 'normal'},
      {move: 'Return', id: 'return', pp: 0, maxpp: 16, target: 'normal'},
      {move: 'Protect', id: 'protect', pp: 16, maxpp: 16, disabled: true, target: 'self'},
    ],
    canMegaEvo: true,
    canMegaEvoX: true,
    canMegaEvoY: true,
    // These may appear in other Showdown formats, but Champions OU does not use them.
    // The benchmark must ignore them instead of offering illegal mechanics.
    canUltraBurst: true,
    canZMove: [
      {move: 'Breakneck Blitz', target: 'normal'},
      null,
      {move: 'Breakneck Blitz', target: 'normal'},
      {move: 'Z-Protect', target: 'self'},
    ],
    canDynamax: true,
    maxMoves: {
      gigantamax: null,
      maxMoves: [
        {move: 'Max Strike', target: 'normal'},
        {move: 'Max Knuckle', target: 'normal'},
        {move: 'Max Strike', target: 'normal'},
        {move: 'Max Guard', target: 'self'},
      ],
    },
    canTerastallize: 'Normal',
  }],
  side: {
    id: 'p1',
    name: 'PS_Test',
    pokemon: [
      {ident: 'p1: Lopunny', condition: '100/100', active: true},
      {ident: 'p1: Clefable', condition: '100/100', active: false},
    ],
  },
};
const specialChoices = legalChoicesFromRequest(specialChoiceRequest);
for (const choice of [
  'move 1 mega',
  'move 1 megax',
  'move 1 megay',
  'move 2 mega',
  'move 2 megax',
  'move 2 megay',
]) {
  assert.equal(specialChoices.includes(choice), true, `${choice} should be legal`);
  assert.equal(isLegalChoice(specialChoiceRequest, choice.toUpperCase()), true, `${choice} should validate case-insensitively`);
}
for (const choice of [
  'move 1 ultra',
  'move 1 zmove',
  'move 1 dynamax',
  'move 1 terastallize',
  'move 2 zmove',
  'move 3 mega',
  'move 4 mega',
  'move 4 dynamax',
]) {
  assert.equal(specialChoices.includes(choice), false, `${choice} should not be offered`);
}
const sanitizedSpecialRequest = sanitizeRequestForPrompt(specialChoiceRequest);
assert.equal(sanitizedSpecialRequest.active[0].canMegaEvo, true);
assert.equal(sanitizedSpecialRequest.active[0].canMegaEvoX, true);
assert.equal(sanitizedSpecialRequest.active[0].canMegaEvoY, true);
assert.equal(sanitizedSpecialRequest.active[0].canUltraBurst, undefined);
assert.equal(sanitizedSpecialRequest.active[0].canDynamax, undefined);
assert.equal(sanitizedSpecialRequest.active[0].canTerastallize, undefined);
assert.equal(sanitizedSpecialRequest.active[0].canZMove, undefined);

const freeze = await loadFreeze();
for (const file of ['data/teams/baseline.txt', 'data/teams/baseline-alt.txt']) {
  const team = await readTextMaybeRoot(file);
  const validation = validateTeam(freeze.formatName, team);
  assert.equal(validation.valid, true, `${file}: ${validation.problems.join('\n')}`);
  assert.equal(validation.pokemonCount, 6);
}

for (const file of ['data/teams/o3.txt', 'data/teams/gpt-5.2.txt', 'data/teams/gpt-5.4.txt', 'data/teams/gpt-5.5.txt']) {
  const team = await readTextMaybeRoot(file);
  const validation = validateTeam(freeze.formatName, team);
  assert.equal(validation.valid, true, `${file}: ${validation.problems.join('\n')}`);
  assert.equal(validation.pokemonCount, 6);
}

const summary = await runTournament({manifestPath: 'config/benchmark.smoke.json'});
assert.equal(summary.games.length, 2);
for (const game of summary.games) {
  assert.equal(typeof game.turns, 'number');
  assert.ok(game.winnerId || game.tie);
}

const ladder = await runLadder({
  manifestPath: 'config/ladder.smoke.json',
  statePath: 'results/test-ladder/state.json',
  matchesPath: 'results/test-ladder/matches.jsonl',
  siteOut: 'site/leaderboard.json',
  games: 2,
});
assert.equal(ladder.gamesCompleted, 2);
assert.equal(ladder.snapshot.players.length, 2);
assert.equal(ladder.snapshot.totalGames >= 2, true);

await fs.rm(fromRoot('results/test-live'), {recursive: true, force: true});
await writeText('results/test-live/o3.jsonl', `${JSON.stringify({
  id: 'battle-gen9championsou-1',
  source: 'pokemon-showdown-live',
  startedAt: '2026-06-16T20:00:00.000Z',
  finishedAt: '2026-06-16T20:08:00.000Z',
  playerId: 'o3',
  model: 'o3',
  accountUsername: 'PS_O3',
  formatId: freeze.formatId,
  formatName: freeze.formatName,
  rated: true,
  roomId: 'battle-gen9championsou-1',
  replayUrl: 'https://replay.pokemonshowdown.com/battle-gen9championsou-1',
  sideId: 'p1',
  player: {sideId: 'p1', username: 'PS_O3', ratingBefore: 1512},
  opponent: {sideId: 'p2', username: 'ladder-user', ratingBefore: 1498},
  winnerName: 'PS_O3',
  winnerIsModel: true,
  result: 'win',
  tie: false,
  turns: 32,
  stats: {choices: 36, invalidActions: 1, timeouts: 0, errors: 0},
})}\n`);
await writeText('results/test-live/gpt-5.2.jsonl', `${JSON.stringify({
  id: 'battle-gen9championsou-2',
  source: 'pokemon-showdown-live',
  startedAt: '2026-06-16T20:10:00.000Z',
  finishedAt: '2026-06-16T20:18:00.000Z',
  playerId: 'gpt-5.2',
  model: 'gpt-5.2',
  accountUsername: 'PS_52',
  formatId: freeze.formatId,
  formatName: freeze.formatName,
  rated: true,
  roomId: 'battle-gen9championsou-2',
  replayUrl: 'https://replay.pokemonshowdown.com/battle-gen9championsou-2',
  sideId: 'p1',
  player: {sideId: 'p1', username: 'PS_52', ratingBefore: 0},
  opponent: {sideId: 'p2', username: 'new-ladder-user', ratingBefore: 0},
  winnerName: 'new-ladder-user',
  winnerIsModel: false,
  result: 'loss',
  tie: false,
  turns: 24,
  stats: {choices: 26, invalidActions: 0, timeouts: 0, errors: 0},
})}\n`);
const liveSnapshot = await publishLiveLeaderboard({
  manifestPath: 'config/ladder.openai.example.json',
  matchesDir: 'results/test-live',
  siteOut: 'site/leaderboard.json',
});
assert.equal(liveSnapshot.ratingSystem.liveInitialRating, 1000);
assert.equal(liveSnapshot.ratingSystem.liveRatingFloor, 1000);
const o3 = liveSnapshot.players.find(player => player.id === 'o3');
assert.equal(o3.games, 1);
assert.equal(o3.rating, 1527);
assert.equal(o3.ratingSource, 'estimated-final');
assert.equal(o3.ratingDelta, 15);
assert.equal(o3.account.username, 'PS_O3');
assert.equal(o3.ratingHistory.at(-1).source, 'estimated-final');
assert.equal(o3.ratingHistory.at(-1).delta, 15);
const gpt52 = liveSnapshot.players.find(player => player.id === 'gpt-5.2');
assert.equal(gpt52.games, 1);
assert.equal(gpt52.rating, 1000);
assert.equal(gpt52.peakRating, 1000);
assert.equal(gpt52.floorRating, 1000);
assert.equal(gpt52.ratingSource, 'initial');
assert.equal(gpt52.ratingDelta, null);
assert.equal(gpt52.ratingHistory.every(point => point.rating >= 1000), true);
const invalidRatingMatch = liveSnapshot.recentMatches.find(match => match.id === 'battle-gen9championsou-2');
assert.equal(invalidRatingMatch.p1.ratingBefore, null);
assert.equal(invalidRatingMatch.p2.ratingBefore, null);

const ratingServer = await startRatingServer(freeze.formatId);
try {
  const polledSnapshot = await publishLiveLeaderboard({
    manifestPath: 'config/ladder.openai.example.json',
    matchesDir: 'results/test-live',
    siteOut: 'site/leaderboard.json',
    pollRatings: true,
    usersBaseUrl: ratingServer.usersBaseUrl,
  });
  const polledO3 = polledSnapshot.players.find(player => player.id === 'o3');
  assert.equal(polledO3.rating, 1555);
  assert.equal(polledO3.ratingSource, 'pokemon-showdown-users-json');
  assert.equal(polledO3.ratingDelta, 43);
  assert.equal(polledO3.ratingDeltaPrevious, 1512);
  assert.equal(polledO3.gxe, 63.4);
  assert.equal(polledO3.glicko, 1642.2);
  assert.equal(polledSnapshot.health.state, 'degraded');
  assert.equal(polledSnapshot.health.activePlayers, 2);
  assert.equal(polledSnapshot.health.totalPlayers, polledSnapshot.players.length);

  const readiness = await auditBenchmarkReadiness({
    manifestPath: 'config/ladder.openai.example.json',
    matchesDir: 'results/test-live',
    sitePath: 'site/leaderboard.json',
    pollRatings: true,
    usersBaseUrl: ratingServer.usersBaseUrl,
  });
  assert.equal(readiness.players.find(player => player.id === 'o3').publicRating.elo, 1555);
} finally {
  await ratingServer.close();
}

console.log(JSON.stringify({
  ok: true,
  freezeDate: freeze.freezeDate,
  format: freeze.formatName,
  games: summary.games.length,
  ladderGames: ladder.snapshot.totalGames,
  livePublishGames: liveSnapshot.totalGames,
  ratings: summary.ratings,
}, null, 2));

function startRatingServer(formatId) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/pso3.json') {
      response.writeHead(404, {'content-type': 'application/json'});
      response.end('{}');
      return;
    }
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({
      username: 'PS_O3',
      userid: 'pso3',
      ratings: {
        [formatId]: {
          elo: 1555,
          gxe: 63.4,
          rpr: 1642.2,
          rprd: 73.8,
          w: 12,
          l: 7,
          coil: null,
        },
      },
    }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      resolve({
        usersBaseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise(closeResolve => server.close(closeResolve)),
      });
    });
  });
}
