import {readJson, readTextMaybeRoot, writeJson} from './core/fs.js';
import {updateElo, resultToScore} from './core/elo.js';
import {loadFreeze} from './showdown/freeze.js';
import {runBattle} from './showdown/battle-runner.js';
import {createAgent} from './agents/factory.js';

export async function runTournament({manifestPath, outPath}) {
  const freeze = await loadFreeze();
  const manifest = await readJson(manifestPath);
  const ratings = Object.fromEntries(
    manifest.players.map(player => [player.id, freeze.ratingSystem.initialRating])
  );
  const games = [];
  const gamesPerPairing = manifest.gamesPerPairing ?? 2;
  let battleIndex = 0;

  for (let i = 0; i < manifest.players.length; i++) {
    for (let j = i + 1; j < manifest.players.length; j++) {
      for (let game = 0; game < gamesPerPairing; game++) {
        const first = game % 2 === 0 ? manifest.players[i] : manifest.players[j];
        const second = game % 2 === 0 ? manifest.players[j] : manifest.players[i];
        const seed = (manifest.seed ?? 1) + battleIndex;
        const result = await runManifestBattle({
          freeze,
          first,
          second,
          seed,
          battleIndex,
        });
        battleIndex++;

        const scoreA = resultToScore(result, first.id);
        const next = updateElo(ratings[first.id], ratings[second.id], scoreA, freeze.ratingSystem.kFactor);
        ratings[first.id] = next.a;
        ratings[second.id] = next.b;
        games.push({
          battleIndex,
          seed,
          p1: first.id,
          p2: second.id,
          winnerId: result.winnerId,
          winnerName: result.winnerName,
          tie: result.tie,
          turns: result.turns,
          invalidActions: {
            [first.id]: result.p1.invalidActions,
            [second.id]: result.p2.invalidActions,
          },
          timeouts: {
            [first.id]: result.p1.timeouts,
            [second.id]: result.p2.timeouts,
          },
          ratings: {
            [first.id]: Math.round(ratings[first.id]),
            [second.id]: Math.round(ratings[second.id]),
          },
        });
      }
    }
  }

  const summary = {
    benchmark: freeze.benchmarkName,
    manifest: manifest.name,
    freezeDate: freeze.freezeDate,
    formatName: freeze.formatName,
    showdownCommit: freeze.showdownCommit,
    ratingSystem: freeze.ratingSystem,
    ratings: Object.fromEntries(Object.entries(ratings).map(([id, rating]) => [id, Math.round(rating)])),
    games,
  };

  if (outPath) await writeJson(outPath, summary);
  return summary;
}

export async function runManifestBattle({freeze, first, second, seed, battleIndex = 0, onPublicLine = null}) {
  const p1Team = await readTextMaybeRoot(first.teamFile);
  const p2Team = await readTextMaybeRoot(second.teamFile);
  return runBattle({
    formatId: freeze.formatId,
    formatName: freeze.formatName,
    seed,
    p1: {
      id: first.id,
      name: first.name ?? first.id,
      team: p1Team,
      agent: createAgent(first, seed + battleIndex * 2 + 1),
    },
    p2: {
      id: second.id,
      name: second.name ?? second.id,
      team: p2Team,
      agent: createAgent(second, seed + battleIndex * 2 + 2),
    },
    onPublicLine: onPublicLine ? event => onPublicLine({
      ...event,
      battleIndex,
      p1: first,
      p2: second,
    }) : null,
  });
}
