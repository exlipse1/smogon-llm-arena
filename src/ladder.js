import {appendJsonl, readJson, readJsonIfExists, writeJson} from './core/fs.js';
import {updateElo, resultToScore} from './core/elo.js';
import {mulberry32, sample} from './core/rng.js';
import {loadFreeze} from './showdown/freeze.js';
import {runManifestBattle} from './tournament.js';

const DEFAULT_STATE_PATH = 'results/ladder/state.json';
const DEFAULT_MATCHES_PATH = 'results/ladder/matches.jsonl';
const DEFAULT_SITE_OUT = 'site/leaderboard.json';
const STATE_VERSION = 1;
const RECENT_MATCH_LIMIT = 100;
const HISTORY_LIMIT = 200;

export async function runLadder(options = {}) {
  const {
    manifestPath = 'config/ladder.openai.example.json',
    statePath = DEFAULT_STATE_PATH,
    matchesPath = DEFAULT_MATCHES_PATH,
    siteOut = DEFAULT_SITE_OUT,
    games = 1,
    continuous = false,
    intervalMs = 10_000,
    onGame = null,
  } = options;

  const freeze = await loadFreeze();
  const manifest = await readJson(manifestPath);
  validateManifest(manifest);

  let state = normalizeState({
    existing: await readJsonIfExists(statePath, null),
    manifest,
    freeze,
  });

  const gamesPerRun = Math.max(1, Number(games));
  let completed = 0;
  do {
    for (let index = 0; index < gamesPerRun; index++) {
      const report = await runOneLadderGame({
        freeze,
        manifest,
        state,
        matchesPath,
      });
      state = report.state;
      await writeJson(statePath, state);
      await writeJson(siteOut, createLeaderboardSnapshot({state, manifest, freeze}));
      completed++;
      if (onGame) onGame(report.matchRecord);
    }

    if (continuous) await sleep(intervalMs);
  } while (continuous);

  return {
    statePath,
    matchesPath,
    siteOut,
    gamesCompleted: completed,
    snapshot: createLeaderboardSnapshot({state, manifest, freeze}),
  };
}

async function runOneLadderGame({freeze, manifest, state, matchesPath}) {
  const activePlayers = activeManifestPlayers(manifest.players);
  const matchup = selectMatchup({manifest, state, players: activePlayers});
  const first = withSelectedTeam(matchup.first, matchup.firstTeam);
  const second = withSelectedTeam(matchup.second, matchup.secondTeam);
  const seed = Number(manifest.seed ?? 1) + state.nextBattleIndex;
  const battleIndex = state.nextBattleIndex;
  const startedAt = new Date().toISOString();
  const before = {
    [first.id]: state.players[first.id].rating,
    [second.id]: state.players[second.id].rating,
  };

  const result = await runManifestBattle({
    freeze,
    first,
    second,
    seed,
    battleIndex,
  });

  const scoreFirst = resultToScore(result, first.id);
  const nextRatings = updateElo(
    state.players[first.id].rating,
    state.players[second.id].rating,
    scoreFirst,
    freeze.ratingSystem.kFactor
  );
  const finishedAt = new Date().toISOString();
  state.players[first.id].rating = nextRatings.a;
  state.players[second.id].rating = nextRatings.b;
  updatePlayerAfterBattle({
    player: state.players[first.id],
    sideStats: result.p1,
    outcome: scoreToOutcome(scoreFirst),
    turns: result.turns,
    rating: nextRatings.a,
    battleIndex,
    at: finishedAt,
  });
  updatePlayerAfterBattle({
    player: state.players[second.id],
    sideStats: result.p2,
    outcome: scoreToOutcome(1 - scoreFirst),
    turns: result.turns,
    rating: nextRatings.b,
    battleIndex,
    at: finishedAt,
  });

  const matchRecord = {
    id: `battle-${String(battleIndex + 1).padStart(6, '0')}`,
    startedAt,
    finishedAt,
    seed,
    matchmaking: manifest.matchmaking ?? 'round-robin',
    teamSelection: manifest.teamSelection ?? (manifest.teamPool?.length ? 'random' : 'fixed'),
    formatId: freeze.formatId,
    formatName: freeze.formatName,
    p1: playerMatchView(first, result.p1, before[first.id], nextRatings.a, matchup.firstTeam),
    p2: playerMatchView(second, result.p2, before[second.id], nextRatings.b, matchup.secondTeam),
    winnerId: result.winnerId,
    winnerName: result.winnerName,
    tie: result.tie,
    turns: result.turns,
  };

  state.nextBattleIndex++;
  state.nextPairingIndex = nextPairingIndex({manifest, state, players: activePlayers});
  state.totalGames++;
  state.updatedAt = finishedAt;
  state.recentMatches.unshift(matchRecord);
  state.recentMatches = state.recentMatches.slice(0, RECENT_MATCH_LIMIT);

  await appendJsonl(matchesPath, matchRecord);
  return {state, matchRecord};
}

function normalizeState({existing, manifest, freeze}) {
  const players = activeManifestPlayers(manifest.players);
  const now = new Date().toISOString();
  const state = existing?.version === STATE_VERSION ? existing : {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    manifestName: manifest.name,
    totalGames: 0,
    nextBattleIndex: 0,
    nextPairingIndex: 0,
    players: {},
    recentMatches: [],
  };

  state.manifestName = manifest.name;
  state.mode = manifest.mode ?? state.mode ?? 'local-shadow-ladder';
  state.track = manifest.track ?? state.track ?? null;
  state.teamPolicy = manifest.teamPolicy ?? state.teamPolicy ?? null;
  state.matchmaking = manifest.matchmaking ?? state.matchmaking ?? 'round-robin';
  state.teamSelection = manifest.teamSelection ?? state.teamSelection ?? (manifest.teamPool?.length ? 'random' : 'fixed');
  state.formatId = freeze.formatId;
  state.formatName = freeze.formatName;
  state.showdownCommit = freeze.showdownCommit;
  state.ratingSystem = freeze.ratingSystem;
  state.players ??= {};
  state.recentMatches ??= [];
  state.totalGames ??= state.recentMatches.length;
  state.nextBattleIndex ??= state.totalGames;
  state.nextPairingIndex ??= 0;

  for (const player of players) {
    const existingPlayer = state.players[player.id];
    state.players[player.id] = normalizePlayer({
      existingPlayer,
      player,
      initialRating: freeze.ratingSystem.initialRating,
    });
  }

  for (const id of Object.keys(state.players)) {
    if (!players.some(player => player.id === id)) {
      state.players[id].inactive = true;
    }
  }

  return state;
}

function normalizePlayer({existingPlayer, player, initialRating}) {
  const rating = Number(existingPlayer?.rating ?? initialRating);
  const account = accountView(player);
  return {
    id: player.id,
    name: player.name ?? player.id,
    type: player.type ?? 'random',
    model: player.model ?? null,
    reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
    teamFile: player.teamFile ?? null,
    account,
    rating,
    peakRating: Math.max(Number(existingPlayer?.peakRating ?? rating), rating),
    floorRating: Math.min(Number(existingPlayer?.floorRating ?? rating), rating),
    games: Number(existingPlayer?.games ?? 0),
    wins: Number(existingPlayer?.wins ?? 0),
    losses: Number(existingPlayer?.losses ?? 0),
    ties: Number(existingPlayer?.ties ?? 0),
    turns: Number(existingPlayer?.turns ?? 0),
    choices: Number(existingPlayer?.choices ?? 0),
    invalidActions: Number(existingPlayer?.invalidActions ?? 0),
    timeouts: Number(existingPlayer?.timeouts ?? 0),
    errors: Number(existingPlayer?.errors ?? 0),
    currentStreak: existingPlayer?.currentStreak ?? {kind: 'none', count: 0},
    lastBattleAt: existingPlayer?.lastBattleAt ?? null,
    ratingHistory: existingPlayer?.ratingHistory?.length ? existingPlayer.ratingHistory : [
      {battle: 0, rating: Math.round(rating), at: null},
    ],
    inactive: false,
  };
}

function updatePlayerAfterBattle({player, sideStats, outcome, turns, rating, battleIndex, at}) {
  player.games++;
  player.turns += turns;
  player.choices += sideStats.choices;
  player.invalidActions += sideStats.invalidActions;
  player.timeouts += sideStats.timeouts;
  player.errors += sideStats.errors;
  player.lastBattleAt = at;
  player.rating = rating;
  player.peakRating = Math.max(player.peakRating, rating);
  player.floorRating = Math.min(player.floorRating, rating);
  player.ratingHistory.push({battle: battleIndex + 1, rating: Math.round(rating), at});
  player.ratingHistory = player.ratingHistory.slice(-HISTORY_LIMIT);

  if (outcome === 'win') player.wins++;
  if (outcome === 'loss') player.losses++;
  if (outcome === 'tie') player.ties++;
  updateStreak(player, outcome);
}

function updateStreak(player, outcome) {
  if (outcome === 'tie') {
    player.currentStreak = {kind: 'tie', count: player.currentStreak?.kind === 'tie' ? player.currentStreak.count + 1 : 1};
    return;
  }
  player.currentStreak = {
    kind: outcome,
    count: player.currentStreak?.kind === outcome ? player.currentStreak.count + 1 : 1,
  };
}

function createLeaderboardSnapshot({state, manifest, freeze}) {
  const season = seasonView(manifest, freeze);
  const players = Object.values(state.players)
    .filter(player => !player.inactive)
    .map(player => ({
      id: player.id,
      name: player.name,
      type: player.type,
      model: player.model,
      reasoningEffort: player.reasoningEffort,
      teamFile: player.teamFile,
      account: player.account,
      rating: Math.round(player.rating),
      ratingDelta: latestRatingDelta(player.ratingHistory),
      peakRating: Math.round(player.peakRating),
      floorRating: Math.round(player.floorRating),
      games: player.games,
      wins: player.wins,
      losses: player.losses,
      ties: player.ties,
      winRate: ratio(player.wins, player.games),
      averageTurns: player.games ? round(player.turns / player.games, 1) : 0,
      choices: player.choices,
      invalidActions: player.invalidActions,
      timeouts: player.timeouts,
      errors: player.errors,
      actionFailureRate: ratio(player.invalidActions + player.timeouts + player.errors, player.choices),
      currentStreak: player.currentStreak,
      lastBattleAt: player.lastBattleAt,
      ratingHistory: player.ratingHistory,
    }))
    .sort((a, b) => b.rating - a.rating);

  const lastBattleAt = state.recentMatches?.[0]?.finishedAt ?? state.updatedAt ?? null;
  return {
    generatedAt: new Date().toISOString(),
    benchmark: freeze.benchmarkName,
    manifestName: manifest.name,
    mode: manifest.mode ?? 'local-shadow-ladder',
    track: manifest.track ?? null,
    teamPolicy: manifest.teamPolicy ?? null,
    matchmaking: manifest.matchmaking ?? 'round-robin',
    teamSelection: manifest.teamSelection ?? (manifest.teamPool?.length ? 'random' : 'fixed'),
    teamPool: (manifest.teamPool ?? []).map(teamView),
    season,
    formatName: freeze.formatName,
    formatId: freeze.formatId,
    battleType: freeze.battleType,
    teamSize: freeze.teamSize,
    freezeDate: freeze.freezeDate,
    showdownCommit: freeze.showdownCommit,
    ratingSystem: freeze.ratingSystem,
    totalGames: state.totalGames,
    health: {
      ok: players.length > 0,
      state: state.totalGames > 0 ? 'active' : 'waiting',
      activePlayers: players.filter(player => player.games > 0).length,
      totalPlayers: players.length,
      waitingPlayers: players.filter(player => player.games === 0).map(player => player.id),
      stalePlayers: [],
      lastBattleAt,
    },
    players,
    recentMatches: state.recentMatches,
  };
}

function playerMatchView(player, sideStats, ratingBefore, ratingAfter, selectedTeam = null) {
  return {
    id: player.id,
    name: player.name ?? player.id,
    model: player.model ?? null,
    reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
    team: teamView(selectedTeam),
    teamFile: selectedTeam?.file ?? player.teamFile ?? null,
    choices: sideStats.choices,
    invalidActions: sideStats.invalidActions,
    timeouts: sideStats.timeouts,
    errors: sideStats.errors,
    ratingBefore: Math.round(ratingBefore),
    ratingAfter: Math.round(ratingAfter),
    ratingDelta: Math.round(ratingAfter - ratingBefore),
  };
}

function accountView(player) {
  const account = player.showdownAccount ?? player.account ?? {};
  const username = account.username ?? (account.usernameEnv ? process.env[account.usernameEnv] : null);
  const passwordConfigured = Boolean(account.passwordEnv && process.env[account.passwordEnv]);
  return {
    username: username ?? null,
    usernameEnv: account.usernameEnv ?? null,
    passwordEnv: account.passwordEnv ?? null,
    configured: Boolean(username && (passwordConfigured || account.assertionEnv)),
  };
}

function buildPairings(players) {
  const pairings = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      pairings.push([i, j], [j, i]);
    }
  }
  return pairings;
}

function validateManifest(manifest) {
  const players = activeManifestPlayers(manifest.players);
  if (!Array.isArray(manifest.players) || players.length < 2) {
    throw new Error('Ladder manifest must contain at least two players.');
  }
  const teamPool = normalizeTeamPool(manifest);
  const ids = new Set();
  for (const player of players) {
    if (!player.id) throw new Error('Every ladder player needs an id.');
    if (ids.has(player.id)) throw new Error(`Duplicate ladder player id: ${player.id}`);
    ids.add(player.id);
    if (!player.teamFile && !teamPool.length) {
      throw new Error(`Ladder player ${player.id} needs a teamFile or the manifest needs a teamPool.`);
    }
  }
}

function activeManifestPlayers(players = []) {
  if (!Array.isArray(players)) return [];
  return players.filter(player => player.enabled !== false);
}

function selectMatchup({manifest, state, players}) {
  if (String(manifest.matchmaking ?? '').toLowerCase() === 'random') {
    const random = mulberry32(Number(manifest.seed ?? 1) + state.nextBattleIndex * 4099 + 17);
    const first = sample(players, random);
    const opponents = players.filter(player => player.id !== first.id);
    const second = sample(opponents, random);
    return {
      first,
      second,
      firstTeam: selectTeam({manifest, player: first, random}),
      secondTeam: selectTeam({manifest, player: second, random}),
    };
  }

  const pairings = buildPairings(players);
  const pairing = pairings[state.nextPairingIndex % pairings.length];
  const first = players[pairing[0]];
  const second = players[pairing[1]];
  const random = mulberry32(Number(manifest.seed ?? 1) + state.nextBattleIndex * 4099 + 31);
  return {
    first,
    second,
    firstTeam: selectTeam({manifest, player: first, random}),
    secondTeam: selectTeam({manifest, player: second, random}),
  };
}

function selectTeam({manifest, player, random}) {
  const teamPool = normalizeTeamPool(manifest);
  const usePool = teamPool.length && (manifest.teamSelection === 'random' || !player.teamFile);
  if (usePool) return sample(teamPool, random);
  return {
    id: player.teamId ?? null,
    name: player.teamName ?? null,
    file: player.teamFile,
  };
}

function withSelectedTeam(player, selectedTeam) {
  return {
    ...player,
    teamFile: selectedTeam?.file ?? player.teamFile,
    selectedTeam: teamView(selectedTeam),
  };
}

function nextPairingIndex({manifest, state, players}) {
  if (String(manifest.matchmaking ?? '').toLowerCase() === 'random') {
    return Number(state.nextPairingIndex ?? 0) + 1;
  }
  const pairings = buildPairings(players);
  return (Number(state.nextPairingIndex ?? 0) + 1) % pairings.length;
}

function normalizeTeamPool(manifest) {
  const seen = new Set();
  return (manifest.teamPool ?? []).map((team, index) => {
    const id = team.id ?? `team-${index + 1}`;
    if (seen.has(id)) throw new Error(`Duplicate teamPool id: ${id}`);
    seen.add(id);
    if (!team.file) throw new Error(`teamPool entry ${id} needs a file.`);
    return {
      id,
      name: team.name ?? id,
      file: team.file,
    };
  });
}

function teamView(team) {
  if (!team) return null;
  return {
    id: team.id ?? null,
    name: team.name ?? team.id ?? null,
    file: team.file ?? null,
  };
}

function seasonView(manifest, freeze) {
  const fallbackId = `${manifest.name ?? 'benchmark'}-${freeze.freezeDate}`;
  if (manifest.season && typeof manifest.season === 'object') {
    return {
      id: manifest.season.id ?? fallbackId,
      name: manifest.season.name ?? manifest.name ?? fallbackId,
      startedAt: manifest.season.startedAt ?? null,
      description: manifest.season.description ?? null,
      resetPolicy: manifest.season.resetPolicy ?? null,
      archiveDir: manifest.season.archiveDir ?? null,
    };
  }
  return {
    id: String(manifest.season ?? fallbackId),
    name: manifest.name ?? String(manifest.season ?? fallbackId),
    startedAt: null,
  };
}

function latestRatingDelta(history = []) {
  const current = history.at?.(-1);
  const previous = history.length > 1 ? history[history.length - 2] : null;
  if (!current || !previous) return 0;
  const delta = Number(current.rating) - Number(previous.rating);
  return Number.isFinite(delta) ? Math.round(delta) : 0;
}

function scoreToOutcome(score) {
  if (score === 1) return 'win';
  if (score === 0) return 'loss';
  return 'tie';
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return round(numerator / denominator, 4);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
