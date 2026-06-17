import {readJson, readJsonIfExists, readJsonlIfExists, writeJson} from './core/fs.js';
import {fromRoot} from './core/paths.js';
import {activePlayers} from './core/manifest.js';
import {loadFreeze} from './showdown/freeze.js';
import {fetchPublicUserRating} from './showdown/public-ratings.js';
import {updateElo} from './core/elo.js';

const HISTORY_LIMIT = 200;
const RECENT_MATCH_LIMIT = 100;
const LIVE_INITIAL_RATING = 1000;
const LIVE_RATING_FLOOR = 1000;

export async function publishLiveLeaderboard(options = {}) {
  const {
    manifestPath = 'config/ladder.openai.example.json',
    matchesDir = 'results/live-ladder',
    statusDir = `${matchesDir}/status`,
    siteOut = 'site/leaderboard.json',
    matchPaths = null,
    pollRatings = false,
    usersBaseUrl,
    staleAfterMs = 6 * 60 * 60 * 1000,
    seasonId = process.env.BENCHMARK_SEASON_ID,
    seasonName = process.env.BENCHMARK_SEASON_NAME,
    seasonStartedAt = process.env.BENCHMARK_SEASON_STARTED_AT,
    archiveDir = null,
  } = options;
  const freeze = await loadFreeze();
  const manifest = await readJson(manifestPath);
  const playersInScope = activePlayers(manifest);
  const recordsByPlayer = new Map();
  const statusByPlayer = new Map();

  for (const player of playersInScope) {
    const paths = matchPaths?.[player.id] ?? [`${matchesDir}/${player.id}.jsonl`];
    const records = [];
    for (const path of paths) {
      records.push(...await readJsonlIfExists(path));
    }
    recordsByPlayer.set(player.id, records.filter(record => record.playerId === player.id));
    statusByPlayer.set(player.id, await readJsonIfExists(`${statusDir}/${player.id}.json`, null));
  }

  const publicRatingsByPlayer = new Map();
  if (pollRatings) {
    for (const player of playersInScope) {
      const records = recordsByPlayer.get(player.id) ?? [];
      const username = accountUsername(player, records);
      if (!username) continue;
      try {
        const rating = await fetchPublicUserRating({
          username,
          formatId: freeze.formatId,
          usersBaseUrl,
        });
        if (rating) publicRatingsByPlayer.set(player.id, rating);
      } catch (error) {
        publicRatingsByPlayer.set(player.id, {
          source: 'pokemon-showdown-users-json',
          fetchedAt: new Date().toISOString(),
          username,
          formatId: freeze.formatId,
          found: false,
          error: String(error?.message ?? error),
        });
      }
    }
  }

  const players = playersInScope
    .map(player => summarizeLivePlayer({
      player,
      records: recordsByPlayer.get(player.id) ?? [],
      initialRating: LIVE_INITIAL_RATING,
      ratingFloor: LIVE_RATING_FLOOR,
      kFactor: Number(freeze.ratingSystem?.kFactor ?? 32),
      publicRating: publicRatingsByPlayer.get(player.id) ?? null,
      liveStatus: statusByPlayer.get(player.id) ?? null,
      staleAfterMs,
    }))
    .sort((a, b) => b.rating - a.rating || b.games - a.games);

  const recentMatches = [];
  for (const [playerId, records] of recordsByPlayer.entries()) {
    const player = playersInScope.find(entry => entry.id === playerId);
    for (const record of records) {
      recentMatches.push(toDashboardMatch(record, player));
    }
  }
  recentMatches.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));

  const generatedAt = new Date().toISOString();
  const season = resolveSeason({
    manifest,
    freeze,
    generatedAt,
    overrides: {seasonId, seasonName, seasonStartedAt},
  });
  const resolvedArchiveDir = archiveDir ?? manifest.season?.archiveDir ?? null;
  const archivePath = resolvedArchiveDir ?
    `${trimTrailingSlash(resolvedArchiveDir)}/${safePathSegment(season.id)}/leaderboard.json` :
    null;
  const health = summarizeBenchmarkHealth({
    players,
    recentMatches,
    generatedAt,
    staleAfterMs,
    pollRatings,
  });

  const snapshot = {
    generatedAt,
    benchmark: freeze.benchmarkName,
    manifestName: manifest.name,
    season,
    mode: 'pokemon-showdown-account-ladder',
    track: manifest.track ?? 'pilot',
    teamPolicy: manifest.teamPolicy ?? null,
    formatName: freeze.formatName,
    formatId: freeze.formatId,
    battleType: freeze.battleType,
    teamSize: freeze.teamSize,
    freezeDate: freeze.freezeDate,
    showdownCommit: freeze.showdownCommit,
    ratingSystem: {
      ...freeze.ratingSystem,
      liveInitialRating: LIVE_INITIAL_RATING,
      liveRatingFloor: LIVE_RATING_FLOOR,
      liveSource: pollRatings ?
        'Pokemon Showdown users JSON API, falling back to battle-start rating' :
        'Pokemon Showdown public ladder rating observed at battle start, plus estimated final point',
    },
    totalGames: players.reduce((sum, player) => sum + player.games, 0),
    health,
    players,
    disabledPlayers: (manifest.players ?? [])
      .filter(player => player.enabled === false)
      .map(player => ({
        id: player.id,
        model: player.model ?? null,
        reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
        reason: player.disabledReason ?? null,
      })),
    recentMatches: recentMatches.slice(0, RECENT_MATCH_LIMIT),
    artifacts: {
      manifestPath,
      matchesDir,
      statusDir,
      siteOut,
      archivePath,
      pollRatings,
      staleAfterMs,
    },
  };

  const publicSnapshot = toPublicLeaderboardSnapshot(snapshot);
  await writeJson(siteOut, publicSnapshot);
  if (archivePath) await writeJson(archivePath, publicSnapshot);
  return snapshot;
}

export function toPublicLeaderboardSnapshot(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    benchmark: snapshot.benchmark,
    manifestName: snapshot.manifestName,
    season: snapshot.season,
    mode: snapshot.mode,
    track: snapshot.track,
    teamPolicy: snapshot.teamPolicy,
    formatName: snapshot.formatName,
    formatId: snapshot.formatId,
    battleType: snapshot.battleType,
    teamSize: snapshot.teamSize,
    freezeDate: snapshot.freezeDate,
    showdownCommit: snapshot.showdownCommit,
    ratingSystem: snapshot.ratingSystem,
    totalGames: snapshot.totalGames,
    health: publicHealthView(snapshot.health),
    players: (snapshot.players ?? []).map(publicPlayerView),
    disabledPlayers: snapshot.disabledPlayers ?? [],
  };
}

function publicHealthView(health) {
  return {
    state: health?.state ?? 'unknown',
    generatedAt: health?.generatedAt ?? null,
    lastBattleAt: health?.lastBattleAt ?? null,
    activePlayers: numberOrNull(health?.activePlayers),
    totalPlayers: numberOrNull(health?.totalPlayers),
  };
}

function publicPlayerView(player) {
  return {
    id: player.id,
    name: player.name,
    type: player.type,
    model: player.model,
    reasoningEffort: player.reasoningEffort,
    teamSource: player.teamSource,
    rating: player.rating,
    benchmarkRating: player.benchmarkRating,
    ratingSource: player.ratingSource,
    ratingDelta: player.ratingDelta,
    ratingDeltaSource: player.ratingDeltaSource,
    ratingDeltaPrevious: player.ratingDeltaPrevious,
    peakRating: player.peakRating,
    floorRating: player.floorRating,
    games: player.games,
    wins: player.wins,
    losses: player.losses,
    ties: player.ties,
    winRate: player.winRate,
    averageTurns: player.averageTurns,
    choices: player.choices,
    invalidActions: player.invalidActions,
    timeouts: player.timeouts,
    errors: player.errors,
    actionFailureRate: player.actionFailureRate,
    currentStreak: player.currentStreak,
    liveStatus: player.liveStatus,
    lastBattleAt: player.lastBattleAt,
    uniqueOpponents: player.uniqueOpponents,
    ratingHistory: player.ratingHistory ?? [],
  };
}

function resolveSeason({manifest, freeze, generatedAt, overrides}) {
  const configured = manifest.season ?? {};
  const id = overrides.seasonId ??
    configured.id ??
    `${manifest.name ?? 'benchmark'}-${manifest.track ?? 'pilot'}-${freeze.freezeDate}`;
  const startedAt = overrides.seasonStartedAt ??
    configured.startedAt ??
    isoStartOfDay(freeze.freezeDate) ??
    generatedAt;
  return {
    id,
    name: overrides.seasonName ?? configured.name ?? titleFromId(id),
    startedAt,
    generatedAt,
    description: configured.description ?? null,
    resetPolicy: configured.resetPolicy ?? null,
  };
}

function summarizeLivePlayer({
  player,
  records,
  initialRating,
  ratingFloor,
  kFactor,
  publicRating = null,
  liveStatus = null,
  staleAfterMs,
}) {
  const ordered = [...records].sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
  const ratingHistory = [{battle: 0, rating: initialRating, at: null, source: 'initial'}];
  let games = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let turns = 0;
  let choices = 0;
  let invalidActions = 0;
  let timeouts = 0;
  let errors = 0;
  let lastBattleAt = null;
  let currentStreak = {kind: 'none', count: 0};
  let rating = initialRating;
  let peakRating = initialRating;
  let floorRating = initialRating;
  const opponents = new Set();

  for (const record of ordered) {
    games++;
    const outcome = normalizeOutcome(record);
    if (outcome === 'win') wins++;
    if (outcome === 'loss') losses++;
    if (outcome === 'tie') ties++;
    currentStreak = nextStreak(currentStreak, outcome);
    turns += Number(record.turns ?? 0);
    choices += Number(record.stats?.choices ?? 0);
    invalidActions += Number(record.stats?.invalidActions ?? 0);
    timeouts += Number(record.stats?.timeouts ?? 0);
    errors += Number(record.stats?.errors ?? 0);
    lastBattleAt = record.finishedAt ?? lastBattleAt;
    if (record.opponent?.username) opponents.add(record.opponent.username);

    const observedRating = liveRatingOrNull(record.player?.ratingBefore, ratingFloor);
    if (observedRating !== null) {
      rating = observedRating;
      peakRating = Math.max(peakRating, observedRating);
      floorRating = Math.min(floorRating, observedRating);
      ratingHistory.push({
        battle: games,
        rating: Math.round(observedRating),
        at: record.startedAt ?? record.finishedAt,
        source: 'battle-start',
      });
    }
  }

  const account = accountView(player);
  if (ordered.at(-1)?.accountUsername) {
    account.username = ordered.at(-1).accountUsername;
    account.configured = true;
  }
  if (publicRating?.username) {
    account.username = publicRating.username;
    account.configured = true;
  }

  const publicElo = liveRatingOrNull(publicRating?.elo, ratingFloor);
  if (publicElo !== null) {
    rating = publicElo;
    peakRating = Math.max(peakRating, publicElo);
    floorRating = Math.min(floorRating, publicElo);
    const lastHistoryPoint = ratingHistory.at(-1);
    const publicSource = publicRating.source ?? 'pokemon-showdown-users-json';
    if (lastHistoryPoint?.rating !== Math.round(publicElo) || lastHistoryPoint?.source !== publicSource) {
      ratingHistory.push({
        battle: games,
        rating: Math.round(publicElo),
        at: publicRating.fetchedAt,
        source: publicSource,
      });
    }
  } else {
    const estimatedFinal = estimateFinalRating({
      record: ordered.at(-1),
      ratingFloor,
      kFactor,
      battle: games,
    });
    if (estimatedFinal) {
      rating = estimatedFinal.rating;
      peakRating = Math.max(peakRating, estimatedFinal.rating);
      floorRating = Math.min(floorRating, estimatedFinal.rating);
      ratingHistory.push(estimatedFinal);
    }
  }

  const ratingDeltaView = currentRatingDelta(ratingHistory, games);

  const now = Date.now();
  const lastBattleAgeMs = lastBattleAt ? Math.max(0, now - Date.parse(lastBattleAt)) : null;
  const stale = !lastBattleAt || lastBattleAgeMs > staleAfterMs;

  return {
    id: player.id,
    name: player.name ?? player.id,
    type: player.type ?? 'openai',
    model: player.model ?? null,
    reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
    teamFile: player.teamFile,
    teamSource: player.teamSource ?? null,
    account,
    rating: Math.round(rating),
    benchmarkRating: Math.round(rating),
    ratingSource: ratingHistory.at(-1)?.source ?? null,
    ratingDelta: ratingDeltaView.delta,
    ratingDeltaSource: ratingDeltaView.source,
    ratingDeltaPrevious: ratingDeltaView.previousRating,
    publicRating: publicRatingView(publicRating),
    gxe: numberOrNull(publicRating?.gxe),
    glicko: numberOrNull(publicRating?.glicko),
    glickoDeviation: numberOrNull(publicRating?.glickoDeviation),
    publicWins: numberOrNull(publicRating?.wins),
    publicLosses: numberOrNull(publicRating?.losses),
    peakRating: Math.round(peakRating),
    floorRating: Math.round(floorRating),
    games,
    wins,
    losses,
    ties,
    winRate: ratio(wins, games),
    averageTurns: games ? round(turns / games, 1) : 0,
    choices,
    invalidActions,
    timeouts,
    errors,
    actionFailureRate: ratio(invalidActions + timeouts + errors, choices),
    currentStreak,
    liveStatus: liveStatusView(liveStatus),
    lastBattleAt,
    freshness: {
      state: !games ? 'waiting-for-first-battle' : (stale ? 'stale' : 'active'),
      stale,
      lastBattleAgeMs,
      staleAfterMs,
    },
    uniqueOpponents: opponents.size,
    ratingHistory: ratingHistory.slice(-HISTORY_LIMIT),
  };
}

function currentRatingDelta(ratingHistory, games) {
  const currentPoint = ratingHistory.at(-1);
  if (!games || !['pokemon-showdown-users-json', 'estimated-final'].includes(currentPoint?.source)) {
    return {delta: null, source: null, previousRating: null};
  }
  const previousPoint = ratingHistory
    .slice(0, -1)
    .reverse()
    .find(point => Number.isFinite(Number(point.rating)));
  if (!previousPoint) return {delta: null, source: null, previousRating: null};
  return {
    delta: Math.round(currentPoint.rating - previousPoint.rating),
    source: currentPoint.source,
    previousRating: Math.round(previousPoint.rating),
  };
}

function estimateFinalRating({record, ratingFloor, kFactor, battle}) {
  if (!record) return null;
  const ratingBefore = liveRatingOrNull(record.player?.ratingBefore, ratingFloor);
  const opponentRating = liveRatingOrNull(record.opponent?.ratingBefore, ratingFloor);
  if (ratingBefore === null || opponentRating === null) return null;
  const outcome = normalizeOutcome(record);
  const score = outcome === 'win' ? 1 : (outcome === 'loss' ? 0 : 0.5);
  const next = updateElo(ratingBefore, opponentRating, score, kFactor).a;
  const estimatedRating = Math.max(ratingFloor, Math.round(next));
  return {
    battle,
    rating: estimatedRating,
    at: record.finishedAt ?? record.startedAt ?? null,
    source: 'estimated-final',
    outcome,
    ratingBefore,
    opponentRating,
    delta: estimatedRating - ratingBefore,
  };
}

function liveStatusView(status) {
  if (!status) {
    return {
      state: 'unknown',
      label: 'Unknown',
      updatedAt: null,
      lastEvent: 'No live status file yet.',
      battleRoomId: null,
      battleStartedAt: null,
      battleTurns: null,
      opponent: null,
    };
  }
  return {
    state: status.state ?? 'unknown',
    label: titleFromId(status.state ?? 'unknown'),
    updatedAt: status.updatedAt ?? null,
    lastEvent: status.lastEvent ?? null,
    battleRoomId: status.battleRoomId ?? null,
    battleStartedAt: status.battleStartedAt ?? null,
    battleTurns: numberOrNull(status.battleTurns),
    opponent: status.opponent ?? null,
    gamesCompleted: numberOrNull(status.gamesCompleted),
  };
}

function summarizeBenchmarkHealth({players, recentMatches, generatedAt, staleAfterMs, pollRatings}) {
  const lastBattleAt = recentMatches[0]?.finishedAt ?? null;
  const activePlayers = players.filter(player => player.games > 0).length;
  const configuredAccounts = players.filter(player => player.account?.configured).length;
  const stalePlayers = players
    .filter(player => player.freshness?.stale)
    .map(player => player.id);
  const waitingPlayers = players
    .filter(player => player.freshness?.state === 'waiting-for-first-battle')
    .map(player => player.id);
  return {
    ok: players.length > 0 && activePlayers === players.length && stalePlayers.length === 0,
    state: !recentMatches.length ? 'waiting-for-battles' : (stalePlayers.length ? 'degraded' : 'active'),
    generatedAt,
    lastBattleAt,
    activePlayers,
    configuredAccounts,
    totalPlayers: players.length,
    stalePlayers,
    waitingPlayers,
    staleAfterMs,
    pollRatings,
  };
}

function accountUsername(player, records) {
  const account = player.showdownAccount ?? player.account ?? {};
  return account.username ??
    (account.usernameEnv ? process.env[account.usernameEnv] : null) ??
    records.findLast?.(record => record.accountUsername)?.accountUsername ??
    [...records].reverse().find(record => record.accountUsername)?.accountUsername ??
    null;
}

function publicRatingView(publicRating) {
  if (!publicRating) return null;
  return {
    source: publicRating.source,
    sourceUrl: publicRating.sourceUrl,
    fetchedAt: publicRating.fetchedAt,
    username: publicRating.username,
    userid: publicRating.userid,
    formatId: publicRating.formatId,
    found: Boolean(publicRating.found),
    error: publicRating.error ?? null,
    elo: numberOrNull(publicRating.elo),
    gxe: numberOrNull(publicRating.gxe),
    glicko: numberOrNull(publicRating.glicko),
    glickoDeviation: numberOrNull(publicRating.glickoDeviation),
    wins: numberOrNull(publicRating.wins),
    losses: numberOrNull(publicRating.losses),
  };
}

function toDashboardMatch(record, player) {
  const outcome = normalizeOutcome(record);
  const playerRating = liveRatingOrNull(record.player?.ratingBefore, LIVE_RATING_FLOOR);
  const opponentRating = liveRatingOrNull(record.opponent?.ratingBefore, LIVE_RATING_FLOOR);
  const opponentId = record.opponent?.username ?? 'ladder-opponent';
  const replayUploaded = Boolean(record.replayUploaded && record.replayUrl);
  return {
    id: record.id ?? record.roomId,
    source: 'pokemon-showdown-live',
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    formatId: record.formatId,
    formatName: record.formatName,
    replayUrl: replayUploaded ? record.replayUrl : null,
    replayUploaded,
    replaySaveError: record.replaySaveError ?? null,
    replaySaveTimedOut: Boolean(record.replaySaveTimedOut),
    rated: Boolean(record.rated),
    p1: {
      id: player?.id ?? record.playerId,
      name: player?.name ?? record.playerId,
      model: player?.model ?? record.model ?? null,
      reasoningEffort: player?.reasoningEffort ?? player?.reasoning?.effort ?? record.reasoningEffort ?? null,
      choices: Number(record.stats?.choices ?? 0),
      invalidActions: Number(record.stats?.invalidActions ?? 0),
      timeouts: Number(record.stats?.timeouts ?? 0),
      errors: Number(record.stats?.errors ?? 0),
      ratingBefore: playerRating,
      ratingAfter: playerRating,
      ratingDelta: playerRating === null ? null : 0,
    },
    p2: {
      id: opponentId,
      name: opponentId,
      model: null,
      choices: 0,
      invalidActions: 0,
      timeouts: 0,
      errors: 0,
      ratingBefore: opponentRating,
      ratingAfter: opponentRating,
      ratingDelta: opponentRating === null ? null : 0,
    },
    winnerId: outcome === 'win' ? record.playerId : (outcome === 'loss' ? opponentId : null),
    winnerName: record.winnerName,
    tie: outcome === 'tie',
    turns: Number(record.turns ?? 0),
  };
}

function normalizeOutcome(record) {
  if (record.tie || record.result === 'tie') return 'tie';
  if (record.result === 'win' || record.winnerIsModel) return 'win';
  if (record.result === 'loss' || record.winnerIsModel === false) return 'loss';
  return 'tie';
}

function nextStreak(current, outcome) {
  if (current?.kind === outcome) return {kind: outcome, count: current.count + 1};
  return {kind: outcome, count: 1};
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

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return round(numerator / denominator, 4);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function liveRatingOrNull(value, floor) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < floor) return null;
  return Math.round(number);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoStartOfDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
  return `${date}T00:00:00.000Z`;
}

function titleFromId(id) {
  return String(id)
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function safePathSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'season';
}

export function defaultLiveMatchPath(playerId, matchesDir = 'results/live-ladder') {
  return fromRoot(matchesDir, `${playerId}.jsonl`);
}
