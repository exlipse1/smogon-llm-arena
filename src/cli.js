#!/usr/bin/env node
import {appendJsonl, readJson, readTextMaybeRoot, writeJson, writeText} from './core/fs.js';
import {loadDotEnv} from './core/env.js';
import {checkFreeze, loadFreeze} from './showdown/freeze.js';
import {validateTeam} from './showdown/teams.js';
import {runBattle} from './showdown/battle-runner.js';
import {createAgent} from './agents/factory.js';
import {OpenAiPokemonAgent} from './agents/openai.js';
import {runTournament} from './tournament.js';
import {runLadder} from './ladder.js';
import {runLiveLadderBot} from './showdown/live-ladder.js';
import {publishLiveLeaderboard} from './live-results.js';
import {auditBenchmarkReadiness} from './readiness.js';

const command = process.argv[2] ?? 'help';
const argv = process.argv.slice(3);

try {
  await loadDotEnv();
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
  } else if (command === 'freeze-check') {
    await freezeCheck();
  } else if (command === 'validate-team') {
    await validateTeams(argv);
  } else if (command === 'match') {
    await match(argv);
  } else if (command === 'tournament') {
    await tournament(argv);
  } else if (command === 'ladder') {
    await ladder(argv);
  } else if (command === 'live-ladder') {
    await liveLadder(argv);
  } else if (command === 'publish-live') {
    await publishLive(argv);
  } else if (command === 'doctor') {
    await doctor(argv);
  } else if (command === 'build-team') {
    await buildTeam(argv);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}

async function freezeCheck() {
  const result = await checkFreeze();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function validateTeams(rawArgs) {
  const args = parseArgs(rawArgs);
  const freeze = await loadFreeze();
  const files = args._.length ? args._ : ['data/teams/baseline.txt', 'data/teams/baseline-alt.txt'];
  let ok = true;
  for (const file of files) {
    const team = await readTextMaybeRoot(file);
    const result = validateTeam(freeze.formatName, team);
    ok = ok && result.valid;
    console.log(JSON.stringify({file, ...result, packed: undefined}, null, 2));
  }
  if (!ok) process.exitCode = 1;
}

async function match(rawArgs) {
  const args = parseArgs(rawArgs);
  const freeze = await loadFreeze();
  const games = Number(args.games ?? 1);
  const seed = Number(args.seed ?? 20260616);
  const teamA = await readTextMaybeRoot(args.teamA ?? args['team-a'] ?? 'data/teams/baseline.txt');
  const teamB = await readTextMaybeRoot(args.teamB ?? args['team-b'] ?? 'data/teams/baseline-alt.txt');
  const agentASpec = {
    id: args.agentA ?? args['agent-a'] ?? 'random-a',
    type: args.typeA ?? args['type-a'] ?? args.agentA ?? args['agent-a'] ?? 'random',
    model: args.modelA ?? args['model-a'],
  };
  const agentBSpec = {
    id: args.agentB ?? args['agent-b'] ?? 'heuristic-b',
    type: args.typeB ?? args['type-b'] ?? args.agentB ?? args['agent-b'] ?? 'heuristic',
    model: args.modelB ?? args['model-b'],
  };
  const results = [];

  for (let game = 0; game < games; game++) {
    const swapped = game % 2 === 1;
    const first = swapped ? agentBSpec : agentASpec;
    const second = swapped ? agentASpec : agentBSpec;
    const result = await runBattle({
      formatId: freeze.formatId,
      formatName: freeze.formatName,
      seed: seed + game,
      p1: {
        id: first.id,
        name: first.id,
        team: swapped ? teamB : teamA,
        agent: createAgent(first, seed + game * 2 + 1),
      },
      p2: {
        id: second.id,
        name: second.id,
        team: swapped ? teamA : teamB,
        agent: createAgent(second, seed + game * 2 + 2),
      },
    });
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }

  if (args.out) await writeJson(args.out, {freeze, results});
}

async function tournament(rawArgs) {
  const args = parseArgs(rawArgs);
  const manifest = args.manifest ?? 'config/benchmark.example.json';
  const result = await runTournament({manifestPath: manifest, outPath: args.out});
  console.log(JSON.stringify(result, null, 2));
}

async function ladder(rawArgs) {
  const args = parseArgs(rawArgs);
  const result = await runLadder({
    manifestPath: args.manifest ?? 'config/ladder.openai.example.json',
    statePath: args.state ?? args['state-path'] ?? 'results/ladder/state.json',
    matchesPath: args.matches ?? args['matches-path'] ?? 'results/ladder/matches.jsonl',
    siteOut: args.site ?? args['site-out'] ?? 'site/leaderboard.json',
    games: Number(args.games ?? 1),
    continuous: Boolean(args.continuous),
    intervalMs: Number(args.intervalMs ?? args['interval-ms'] ?? 10_000),
    battleTimeoutMs: Number(args.battleTimeoutMs ?? args['battle-timeout-ms'] ?? 15 * 60 * 1000),
    onBattleLogLine: booleanArg(args, 'printMoves', 'print-moves', false) ? event => {
      const line = formatMoveLogLine(event);
      if (line) console.log(line);
    } : null,
    onGame: match => {
      console.log(JSON.stringify({
        match: match.id,
        p1: match.p1.id,
        p2: match.p2.id,
        winnerId: match.winnerId,
        tie: match.tie,
        turns: match.turns,
        ratings: {
          [match.p1.id]: match.p1.ratingAfter,
          [match.p2.id]: match.p2.ratingAfter,
        },
      }));
    },
  });
  console.log(JSON.stringify({
    ok: true,
    gamesCompleted: result.gamesCompleted,
    statePath: result.statePath,
    matchesPath: result.matchesPath,
    siteOut: result.siteOut,
    leaders: result.snapshot.players.slice(0, 5).map(player => ({
      id: player.id,
      rating: player.rating,
      games: player.games,
      winRate: player.winRate,
    })),
  }, null, 2));
}

async function liveLadder(rawArgs) {
  const args = parseArgs(rawArgs);
  const freeze = await loadFreeze();
  const manifestPath = args.manifest ?? 'config/ladder.openai.example.json';
  const manifest = await readJson(manifestPath);
  const playerId = args.player ?? args['player-id'];
  if (!playerId) throw new Error('live-ladder requires --player <id>.');
  const player = manifest.players?.find(entry => entry.id === playerId);
  if (!player) throw new Error(`No player named ${playerId} in ${manifestPath}.`);
  const matchesPath = args.matches ?? args['matches-path'] ?? `results/live-ladder/${player.id}.jsonl`;
  const statusPath = args.status ?? args['status-path'] ?? null;
  const result = await runLiveLadderBot({
    player,
    freeze,
    games: args.continuous ? Infinity : Number(args.games ?? 1),
    serverUrl: args.server ?? args['server-url'],
    loginUrl: args.loginUrl ?? args['login-url'],
    choiceTimeoutMs: Number(args.choiceTimeoutMs ?? args['choice-timeout-ms'] ?? 20_000),
    searchDelayMs: Number(args.searchDelayMs ?? args['search-delay-ms'] ?? 5_000),
    log: Boolean(args.log),
    onBattleEnd: async record => {
      await appendJsonl(matchesPath, record);
      console.log(JSON.stringify(record));
    },
    onStatus: statusPath ? async status => {
      await writeJson(statusPath, status);
    } : null,
  });
  console.log(JSON.stringify({ok: true, player: player.id, matchesPath, ...result}, null, 2));
}

async function publishLive(rawArgs) {
  const args = parseArgs(rawArgs);
  const snapshot = await publishLiveLeaderboard({
    manifestPath: args.manifest ?? 'config/ladder.openai.example.json',
    matchesDir: args.matchesDir ?? args['matches-dir'] ?? 'results/live-ladder',
    statusDir: args.statusDir ?? args['status-dir'],
    siteOut: args.site ?? args['site-out'] ?? 'site/leaderboard.json',
    pollRatings: booleanArg(args, 'pollRatings', 'poll-ratings', false),
    usersBaseUrl: args.usersBaseUrl ?? args['users-base-url'],
    seasonId: args.seasonId ?? args['season-id'],
    seasonName: args.seasonName ?? args['season-name'],
    seasonStartedAt: args.seasonStartedAt ?? args['season-started-at'],
    archiveDir: args.archiveDir ?? args['archive-dir'],
  });
  console.log(JSON.stringify({
    ok: true,
    siteOut: args.site ?? args['site-out'] ?? 'site/leaderboard.json',
    archivePath: snapshot.artifacts.archivePath,
    season: snapshot.season,
    totalGames: snapshot.totalGames,
    leaders: snapshot.players.slice(0, 5).map(player => ({
      id: player.id,
      rating: player.rating,
      games: player.games,
      winRate: player.winRate,
      gxe: player.gxe,
      account: player.account.username ?? player.account.usernameEnv,
    })),
  }, null, 2));
}

async function doctor(rawArgs) {
  const args = parseArgs(rawArgs);
  const report = await auditBenchmarkReadiness({
    manifestPath: args.manifest ?? 'config/ladder.openai.example.json',
    matchesDir: args.matchesDir ?? args['matches-dir'] ?? 'results/live-ladder',
    sitePath: args.site ?? args['site-path'] ?? 'site/leaderboard.json',
    pollRatings: Boolean(args.pollRatings ?? args['poll-ratings']),
    usersBaseUrl: args.usersBaseUrl ?? args['users-base-url'],
    externalUrl: args.externalUrl ?? args['external-url'],
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok && args.strict) process.exitCode = 1;
}

async function buildTeam(rawArgs) {
  const args = parseArgs(rawArgs);
  const freeze = await loadFreeze();
  const out = args.out ?? 'data/teams/gpt-5.5.txt';
  const model = args.model ?? process.env.OPENAI_MODEL ?? 'gpt-5.5';
  const reasoningEffort = args.reasoningEffort ?? args['reasoning-effort'] ?? process.env.OPENAI_REASONING_EFFORT ?? null;
  const attempts = Number(args.attempts ?? 3);
  const agent = new OpenAiPokemonAgent({model, reasoningEffort});
  const team = await agent.buildTeam({formatName: freeze.formatName, freeze, attempts});
  const validation = validateTeam(freeze.formatName, team);
  if (!validation.valid) {
    throw new Error(`Generated team failed validation:\n${validation.problems.join('\n')}`);
  }
  await writeText(out, team);
  console.log(JSON.stringify({out, model, reasoningEffort, valid: true, pokemonCount: validation.pokemonCount}, null, 2));
}

function parseArgs(rawArgs) {
  const args = {_: []};
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const [key, inlineValue] = withoutPrefix.split('=', 2);
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }
    const next = rawArgs[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function booleanArg(parsed, camelName, kebabName, defaultValue) {
  const value = parsed[camelName] ?? parsed[kebabName];
  if (value === undefined) return defaultValue;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  return Boolean(value);
}

function formatMoveLogLine(event) {
  const line = String(event.line ?? '');
  const battleId = `battle-${String(Number(event.battleIndex ?? 0) + 1).padStart(6, '0')}`;
  const parts = line.split('|');
  const sideName = ident => {
    const side = String(ident ?? '').slice(0, 2);
    if (side === 'p1') return event.p1?.id ?? 'p1';
    if (side === 'p2') return event.p2?.id ?? 'p2';
    return side || 'field';
  };
  const pokemonName = ident => String(ident ?? '').replace(/^p[12][a-z]?:\s*/i, '');

  if (line.startsWith('|turn|')) return `[${battleId}] turn ${parts[2]}`;
  if (line.startsWith('|move|')) {
    return `[${battleId}] turn ${event.turn}: ${sideName(parts[2])} ${pokemonName(parts[2])} used ${parts[3]} -> ${pokemonName(parts[4])}`;
  }
  if (line.startsWith('|switch|')) {
    return `[${battleId}] turn ${event.turn}: ${sideName(parts[2])} switched to ${pokemonName(parts[2])}`;
  }
  if (line.startsWith('|drag|')) {
    return `[${battleId}] turn ${event.turn}: ${sideName(parts[2])} was dragged to ${pokemonName(parts[2])}`;
  }
  if (line.startsWith('|faint|')) return `[${battleId}] turn ${event.turn}: ${sideName(parts[2])} ${pokemonName(parts[2])} fainted`;
  if (line.startsWith('|win|')) return `[${battleId}] winner: ${parts[2]}`;
  if (line === '|tie') return `[${battleId}] tie`;
  return null;
}

function printHelp() {
  console.log(`Smogon LLM Arena

Commands:
  freeze-check
    Verify the pinned Showdown install still exposes frozen Champions OU.

  validate-team [team files...]
    Validate Showdown importables against frozen Champions OU.

  match --agent-a random --agent-b heuristic --games 2
    Run mirrored local battles. Agent types: random, heuristic, openai.

  tournament --manifest config/benchmark.example.json --out results/run.json
    Run round-robin Elo evaluation from a manifest.

  ladder --manifest config/ladder.openai.example.json --games 12
    Run persistent ladder games, append match records, and publish site JSON.

  ladder --manifest config/model-league.openai.json --games 12
    Run the balanced random model-vs-model league using the fixed sample team pool.
    Add --print-moves to stream moves, switches, faints, and winners.

  live-ladder --manifest config/ladder.openai.example.json --player gpt-5.5 --games 3
    Log into one Pokemon Showdown account, search the live ladder, and choose actions.

  publish-live --manifest config/ladder.openai.example.json --matches-dir results/live-ladder --poll-ratings
    Rebuild the website payload from live account JSONL logs and optional public rating polls.

  doctor --manifest config/ladder.openai.example.json --poll-ratings
    Audit team files, credentials, live logs, site payload, and optional public ratings.

  build-team --model gpt-5.5 --out data/teams/gpt-5.5.txt
    Ask the OpenAI model for a legal Champions OU importable and validate it.

  npm run gpt55
    Build GPT-5.5's team and run the default GPT-5.5 Champion Track manifest.
`);
}
