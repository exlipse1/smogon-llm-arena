import {legalChoicesFromRequest, isLegalChoice, normalizeChoice, sanitizeRequestForPrompt} from '../core/choices.js';
import {timerStatusForPrompt} from '../core/timer.js';
import {intSeedToShowdownSeed, sample} from '../core/rng.js';
import {loadShowdown} from './load.js';
import {packTeam, validateTeam} from './teams.js';

const DEFAULT_CHOICE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TURNS = 500;

export async function runBattle(options) {
  const {
    formatId,
    formatName,
    p1,
    p2,
    seed = 1,
    choiceTimeoutMs = DEFAULT_CHOICE_TIMEOUT_MS,
    maxTurns = DEFAULT_MAX_TURNS,
    log = false,
  } = options;

  const p1Validation = validateTeam(formatName, p1.team);
  const p2Validation = validateTeam(formatName, p2.team);
  if (!p1Validation.valid) throw new Error(`${p1.id} team is invalid:\n${p1Validation.problems.join('\n')}`);
  if (!p2Validation.valid) throw new Error(`${p2.id} team is invalid:\n${p2Validation.problems.join('\n')}`);

  const {BattleStream, getPlayerStreams} = loadShowdown();
  const battleStream = new BattleStream({keepAlive: false});
  const streams = getPlayerStreams(battleStream);
  const state = {
    formatId,
    formatName,
    seed,
    winnerName: null,
    winnerId: null,
    tie: false,
    ended: false,
    turns: 0,
    log: [],
    sideStats: {
      p1: createSideStats(p1.id),
      p2: createSideStats(p2.id),
    },
  };

  const p1Task = processPlayerStream({
    sideId: 'p1',
    player: p1,
    opponent: p2,
    stream: streams.p1,
    state,
    choiceTimeoutMs,
    maxTurns,
  });
  const p2Task = processPlayerStream({
    sideId: 'p2',
    player: p2,
    opponent: p1,
    stream: streams.p2,
    state,
    choiceTimeoutMs,
    maxTurns,
  });
  const spectatorTask = processSpectatorStream(streams.spectator, state);

  await streams.omniscient.write(`>start ${JSON.stringify({formatid: formatId, seed: intSeedToShowdownSeed(seed)})}`);
  await streams.omniscient.write(`>player p1 ${JSON.stringify({name: p1.name ?? p1.id, team: packTeam(p1.team)})}`);
  await streams.omniscient.write(`>player p2 ${JSON.stringify({name: p2.name ?? p2.id, team: packTeam(p2.team)})}`);

  await Promise.all([p1Task, p2Task, spectatorTask]);

  if (state.winnerName) {
    if (state.winnerName === (p1.name ?? p1.id)) state.winnerId = p1.id;
    if (state.winnerName === (p2.name ?? p2.id)) state.winnerId = p2.id;
  }

  const result = {
    formatId,
    formatName,
    seed,
    winnerName: state.winnerName,
    winnerId: state.winnerId,
    tie: state.tie,
    turns: state.turns,
    p1: state.sideStats.p1,
    p2: state.sideStats.p2,
  };

  if (log) result.log = state.log;
  return result;
}

async function processPlayerStream({sideId, player, opponent, stream, state, choiceTimeoutMs, maxTurns}) {
  const sideLog = [];
  for await (const chunk of stream) {
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      sideLog.push(line);
      if (sideLog.length > 80) sideLog.shift();
      handlePublicLine(line, state);

      if (line.startsWith('|error|')) {
        state.sideStats[sideId].invalidActions++;
      }

      if (!line.startsWith('|request|')) continue;
      const requestText = line.slice('|request|'.length);
      if (!requestText || requestText === 'null') continue;
      const request = JSON.parse(requestText);
      if (request.wait) continue;
      if (state.turns > maxTurns) {
        await stream.write('default');
        continue;
      }

      const legalChoices = legalChoicesFromRequest(request);
      const context = {
        formatId: state.formatId,
        formatName: state.formatName,
        sideId,
        playerId: player.id,
        opponentId: opponent.id,
        turn: state.turns,
        request: sanitizeRequestForPrompt(request),
        legalChoices,
        timer: timerStatusForPrompt({request, publicLog: sideLog}),
        publicLog: sideLog.slice(-40),
      };
      const choiceResult = await chooseWithTimeout(player.agent, context, choiceTimeoutMs);
      if (choiceResult.timeout) state.sideStats[sideId].timeouts++;
      if (choiceResult.error) state.sideStats[sideId].errors++;
      const finalChoice = coerceChoice({choice: choiceResult.choice, request, legalChoices, state, sideId});
      state.sideStats[sideId].choices++;
      state.sideStats[sideId].choiceLog.push({turn: state.turns, requested: choiceResult.choice, used: finalChoice});
      if (state.sideStats[sideId].choiceLog.length > 200) state.sideStats[sideId].choiceLog.shift();
      await stream.write(finalChoice);
    }
  }
}

async function processSpectatorStream(stream, state) {
  for await (const chunk of stream) {
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      state.log.push(line);
      handlePublicLine(line, state);
    }
  }
}

function handlePublicLine(line, state) {
  if (line.startsWith('|turn|')) {
    state.turns = Number(line.slice('|turn|'.length)) || state.turns;
  } else if (line.startsWith('|win|')) {
    state.winnerName = line.slice('|win|'.length);
    state.ended = true;
  } else if (line === '|tie') {
    state.tie = true;
    state.ended = true;
  }
}

async function chooseWithTimeout(agent, context, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise(resolve => {
    timeout = setTimeout(() => resolve({choice: 'default', timeout: true}), timeoutMs);
  });
  const choicePromise = Promise.resolve(agent.chooseAction(context))
    .then(choice => ({choice, timeout: false}))
    .catch(error => ({choice: 'default', timeout: false, error: String(error?.message ?? error)}));
  const result = await Promise.race([choicePromise, timeoutPromise]);
  clearTimeout(timeout);
  return result;
}

function coerceChoice({choice, request, legalChoices, state, sideId}) {
  const normalized = normalizeChoice(choice);
  if (isLegalChoice(request, normalized)) return normalized;

  state.sideStats[sideId].invalidActions++;
  if (legalChoices.length) return sample(legalChoices, Math.random);
  return 'default';
}

function createSideStats(playerId) {
  return {
    playerId,
    choices: 0,
    invalidActions: 0,
    timeouts: 0,
    errors: 0,
    choiceLog: [],
  };
}
