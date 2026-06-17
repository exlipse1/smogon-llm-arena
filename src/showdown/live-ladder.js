import {legalChoicesFromRequest, isLegalChoice, normalizeChoice} from '../core/choices.js';
import {readTextMaybeRoot} from '../core/fs.js';
import {createAgent} from '../agents/factory.js';
import {packTeam, validateTeam} from './teams.js';
import {buildTacticalContext, decisionTimeoutForContext, fallbackChoiceForContext} from './tactical-harness.js';

const DEFAULT_SERVER_URL = 'wss://sim3.psim.us/showdown/websocket';
const DEFAULT_LOGIN_URL = 'https://play.pokemonshowdown.com/api/login';
const DEFAULT_CHOICE_TIMEOUT_MS = 20_000;
const DEFAULT_SEARCH_DELAY_MS = 5_000;
const DEFAULT_REPLAY_UPLOAD_TIMEOUT_MS = 10_000;
export const AGENT_DECISION_FAILURE_EXIT_CODE = 75;

export async function runLiveLadderBot(options) {
  const {
    player,
    freeze,
    games = Infinity,
    serverUrl = DEFAULT_SERVER_URL,
    loginUrl = DEFAULT_LOGIN_URL,
    choiceTimeoutMs = DEFAULT_CHOICE_TIMEOUT_MS,
    searchDelayMs = DEFAULT_SEARCH_DELAY_MS,
    replayUploadTimeoutMs = DEFAULT_REPLAY_UPLOAD_TIMEOUT_MS,
    log = false,
    onBattleEnd = null,
    onStatus = null,
    WebSocketClass = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof WebSocketClass !== 'function') {
    throw new Error('The live ladder bot needs a Node.js runtime with global WebSocket support.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('The live ladder bot needs a fetch implementation for Pokemon Showdown login.');
  }
  if (!player) throw new Error('runLiveLadderBot requires a player manifest entry.');

  const credentials = resolveCredentials(player);
  const teamText = await readTextMaybeRoot(player.teamFile);
  const validation = validateTeam(freeze.formatName, teamText);
  if (!validation.valid) {
    throw new Error(`${player.id} team is invalid:\n${validation.problems.join('\n')}`);
  }
  const packedTeam = packTeam(teamText);
  const agent = createAgent(player);
  const socket = new WebSocketClass(serverUrl);
  const accountUserId = toId(credentials.username);
  const state = {
    loggedIn: false,
    searching: false,
    gamesCompleted: 0,
    activeBattleKey: null,
    activeBattleRoomId: null,
    stoppedForAgentError: false,
    completedBattleRooms: new Set(),
    completedBattleRoomOrder: [],
    ignoredBattleRooms: new Set(),
    battles: new Map(),
  };
  let lastStatus = {};
  let statusQueue = Promise.resolve();
  void emitStatus({state: 'connecting', lastEvent: 'opening Pokemon Showdown WebSocket'});

  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      if (log) console.log(`Connected to ${serverUrl}`);
      void emitStatus({state: 'connected', lastEvent: 'connected to Pokemon Showdown'});
    });
    socket.addEventListener('error', event => {
      void emitStatus({state: 'error', lastEvent: `WebSocket error: ${event?.message ?? 'unknown error'}`});
      reject(new Error(`Pokemon Showdown WebSocket error: ${event?.message ?? 'unknown error'}`));
    });
    socket.addEventListener('close', () => {
      if (state.stoppedForAgentError) return;
      if (state.gamesCompleted >= games) {
        void emitStatus({state: 'stopped', lastEvent: 'completed requested games'});
        resolve({gamesCompleted: state.gamesCompleted});
      } else {
        void emitStatus({state: 'error', lastEvent: 'WebSocket closed before requested games completed'});
        reject(new Error('Pokemon Showdown WebSocket closed before requested games completed.'));
      }
    });
    socket.addEventListener('message', event => {
      handleSocketMessage(String(event.data)).catch(reject);
    });

    async function handleSocketMessage(raw) {
      for (const block of unpackSockJsFrame(raw)) {
        const parsed = parseRoomBlock(block);
        for (const line of parsed.lines) {
          if (log && shouldLogLine(line)) console.log(`${parsed.roomId || 'global'} ${line}`);
          await handleLine(parsed.roomId, line);
        }
      }
    }

    async function handleLine(roomId, line) {
      if (line.startsWith('|popup|') && handleReplayPopupForRoom(roomId, line)) return;

      if (line.startsWith('|challstr|')) {
        const challstr = line.slice('|challstr|'.length);
        await emitStatus({state: 'logging-in', lastEvent: 'received challstr'});
        const assertion = await requestAssertion({loginUrl, challstr, fetchImpl, ...credentials});
        send('', `/trn ${credentials.username},0,${assertion}`);
        return;
      }

      if (line.startsWith('|updateuser|')) {
        const named = line.split('|')[3] === '1';
        if (named && !state.loggedIn) {
          state.loggedIn = true;
          await emitStatus({state: 'logged-in', lastEvent: 'logged in'});
          queueSearch();
        }
        return;
      }

      if (line.startsWith('|updatesearch|')) {
        const search = JSON.parse(line.slice('|updatesearch|'.length));
        state.searching = Boolean(search.searching?.includes(freeze.formatId));
        const battleRoomIds = Object.keys(search.games ?? {});
        if (battleRoomIds.length) state.searching = false;
        for (const battleRoomId of battleRoomIds) {
          const battle = activateBattle(battleRoomId);
          if (!battle) continue;
          await emitBattleStatus('in-battle', battle, 'battle assigned');
        }
        if (!battleRoomIds.length && state.searching) {
          await emitStatus({
            state: 'searching',
            searching: true,
            battleRoomId: null,
            battleStartedAt: null,
            battleTurns: null,
            opponent: null,
            lastEvent: `searching ${freeze.formatId}`,
          });
        }
        return;
      }

      if (line.startsWith('|init|battle')) {
        const battle = activateBattle(roomId);
        if (!battle) return;
        enableTimer(roomId, battle);
        await emitBattleStatus('in-battle', battle, 'joined battle room');
        return;
      }

      if (!roomId?.startsWith('battle-')) return;
      if (!shouldHandleBattle(roomId, line)) return;
      const battle = ensureBattle(roomId);
      enableTimer(roomId, battle);
      battle.publicLog.push(line);
      if (battle.publicLog.length > 80) battle.publicLog.shift();

      if (line.startsWith('|player|')) {
        handlePlayerLine(battle, line);
        await emitBattleStatus('in-battle', battle, 'player update');
        return;
      }
      if (line.startsWith('|rated')) {
        battle.rated = true;
        return;
      }
      if (line.startsWith('|error|')) {
        battle.stats.invalidActions++;
        return;
      }
      if (line.startsWith('|turn|')) {
        battle.turns = Number(line.slice('|turn|'.length)) || battle.turns;
        await emitBattleStatus('in-battle', battle, `turn ${battle.turns}`);
        return;
      }
      if (line.startsWith('|win|')) {
        battle.winnerName = line.slice('|win|'.length);
        await finishBattle(roomId, battle, false);
        return;
      }
      if (line === '|tie') {
        battle.tie = true;
        await finishBattle(roomId, battle, true);
        return;
      }
      if (line.startsWith('|request|')) {
        await answerRequest(roomId, battle, line.slice('|request|'.length));
      }
    }

    async function answerRequest(roomId, battle, requestText) {
      if (!requestText || requestText === 'null') return;
      const request = JSON.parse(requestText);
      if (request.wait) return;

      battle.sideId = request.side?.id ?? battle.sideId;
      const legalChoices = legalChoicesFromRequest(request);
      const context = buildTacticalContext({freeze, battle, player, request, legalChoices});
      await emitBattleStatus('choosing', battle, `choosing on turn ${battle.turns}`);
      const choiceResult = await chooseWithTimeout(
        agent,
        context,
        decisionTimeoutForContext(context, choiceTimeoutMs),
        () => fallbackChoiceForContext(context),
      );
      if (choiceResult.error) {
        battle.stats.errors++;
        await stopAfterAgentError(roomId, battle, choiceResult.error);
        return;
      }
      if (choiceResult.timeout) battle.stats.timeouts++;
      const choice = coerceChoice(choiceResult.choice, request, legalChoices, battle.stats);
      battle.stats.choices++;
      await emitBattleStatus('sent-choice', battle, `sent ${choice}`);
      const rqid = request.rqid ? `|${request.rqid}` : '';
      send(roomId, `/choose ${choice}${rqid}`);
    }

    async function finishBattle(roomId, battle, tie) {
      if (battle.ended) return;
      battle.ended = true;
      state.gamesCompleted++;
      const replaySave = await saveReplay(roomId, battle);
      const record = {
        id: roomId,
        source: 'pokemon-showdown-live',
        startedAt: battle.startedAt,
        finishedAt: new Date().toISOString(),
        playerId: player.id,
        model: player.model ?? null,
        reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
        accountUsername: credentials.username,
        formatId: freeze.formatId,
        formatName: freeze.formatName,
        rated: battle.rated,
        roomId,
        replayUrl: replaySave.url,
        replayUploaded: Boolean(replaySave.url),
        replaySaveError: replaySave.error,
        replaySaveTimedOut: replaySave.timedOut,
        sideId: battle.sideId,
        player: ownPlayerView(battle, credentials.username),
        opponent: opponentPlayerView(battle),
        winnerName: battle.winnerName,
        winnerIsModel: tie ? false : toId(battle.winnerName) === accountUserId,
        result: tie ? 'tie' : (toId(battle.winnerName) === accountUserId ? 'win' : 'loss'),
        tie,
        turns: battle.turns,
        stats: battle.stats,
      };
      if (onBattleEnd) await onBattleEnd(record);
      rememberCompletedBattleRoom(roomId);
      await emitBattleStatus('battle-ended', battle, `battle ended: ${record.result}`);
      state.battles.delete(battleRoomKey(roomId));
      if (state.activeBattleKey === battleRoomKey(roomId)) {
        state.activeBattleKey = null;
        state.activeBattleRoomId = null;
      }
      if (state.gamesCompleted >= games) {
        send('', '/cancelsearch');
        socket.close();
      } else {
        setTimeout(queueSearch, searchDelayMs);
      }
    }

    async function stopAfterAgentError(roomId, battle, error) {
      const agentError = summarizeAgentError(error);
      state.stoppedForAgentError = true;
      state.searching = false;
      send('', '/cancelsearch');
      send(roomId, '/forfeit');
      await recordAgentErrorBattle(roomId, battle, agentError);
      await emitStatus({
        state: 'error',
        searching: false,
        battleRoomId: battle.roomId,
        battleStartedAt: battle.startedAt,
        battleTurns: battle.turns,
        opponent: opponentPlayerView(battle).username ? opponentPlayerView(battle) : null,
        agentError,
        lastEvent: `stopped after agent decision error: ${agentError}`,
      });
      try {
        socket.close();
      } catch {
        // The socket may already be closing.
      }
      const stopError = new Error(`Agent decision failed for ${player.id}: ${agentError}`);
      stopError.exitCode = AGENT_DECISION_FAILURE_EXIT_CODE;
      throw stopError;
    }

    async function recordAgentErrorBattle(roomId, battle, agentError) {
      if (battle.ended) return;
      battle.ended = true;
      state.gamesCompleted++;
      if (onBattleEnd) {
        await onBattleEnd({
          id: roomId,
          source: 'pokemon-showdown-live',
          startedAt: battle.startedAt,
          finishedAt: new Date().toISOString(),
          playerId: player.id,
          model: player.model ?? null,
          reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
          accountUsername: credentials.username,
          formatId: freeze.formatId,
          formatName: freeze.formatName,
          rated: battle.rated,
          roomId,
          replayUrl: null,
          replayUploaded: false,
          replaySaveError: agentError,
          replaySaveTimedOut: false,
          sideId: battle.sideId,
          player: ownPlayerView(battle, credentials.username),
          opponent: opponentPlayerView(battle),
          winnerName: opponentPlayerView(battle).username ?? null,
          winnerIsModel: false,
          result: 'loss',
          tie: false,
          turns: battle.turns,
          forcedForfeit: true,
          forcedForfeitReason: 'agent-decision-error',
          agentError,
          stats: battle.stats,
        });
      }
      rememberCompletedBattleRoom(roomId);
      state.battles.delete(battleRoomKey(roomId));
      if (state.activeBattleKey === battleRoomKey(roomId)) {
        state.activeBattleKey = null;
        state.activeBattleRoomId = null;
      }
    }

    async function saveReplay(roomId, battle) {
      if (!replayUploadTimeoutMs || replayUploadTimeoutMs < 0) {
        return {url: null, error: null, timedOut: false};
      }
      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          if (battle.pendingReplaySave?.resolve === finish) {
            battle.pendingReplaySave = null;
          }
          finish({url: null, error: null, timedOut: true});
        }, replayUploadTimeoutMs);
        function finish(result) {
          clearTimeout(timeout);
          if (battle.pendingReplaySave?.resolve === finish) {
            battle.pendingReplaySave = null;
          }
          resolve(result);
        }
        battle.pendingReplaySave = {resolve: finish};
        send(roomId, '/savereplay');
      });
    }

    function handleReplayPopupForRoom(roomId, line) {
      let battle = null;
      if (roomId?.startsWith('battle-')) {
        battle = state.battles.get(battleRoomKey(roomId)) ?? null;
      }
      battle ??= [...state.battles.values()].find(entry => entry.pendingReplaySave) ?? null;
      return battle ? handleReplayPopup(battle, line) : false;
    }

    function handleReplayPopup(battle, line) {
      const pending = battle.pendingReplaySave;
      if (!pending) return false;
      const url = extractReplayUrl(line);
      if (url) {
        pending.resolve({url, error: null, timedOut: false});
        return true;
      }
      if (/could not be saved|can only save replays/i.test(line)) {
        pending.resolve({
          url: null,
          error: popupText(line),
          timedOut: false,
        });
        return true;
      }
      return false;
    }

    function queueSearch() {
      if (state.stoppedForAgentError || !state.loggedIn || state.searching || state.activeBattleKey || state.gamesCompleted >= games) return;
      send('', `/utm ${packedTeam}`);
      send('', `/search ${freeze.formatId}`);
      state.searching = true;
      void emitStatus({
        state: 'searching',
        searching: true,
        battleRoomId: null,
        battleStartedAt: null,
        battleTurns: null,
        opponent: null,
        lastEvent: `searching ${freeze.formatId}`,
      });
    }

    function send(roomId, text) {
      socket.send(`${roomId}|${text}`);
    }

    function activateBattle(roomId) {
      if (!roomId?.startsWith('battle-')) return null;
      const key = battleRoomKey(roomId);
      if (state.completedBattleRooms.has(key)) return null;
      if (state.ignoredBattleRooms.has(key)) return null;
      if (state.activeBattleKey && state.activeBattleKey !== key) {
        ignoreExtraBattle(roomId);
        return null;
      }
      const firstActivation = state.activeBattleKey !== key;
      state.activeBattleKey = key;
      state.activeBattleRoomId = preferBattleRoomId(state.activeBattleRoomId, roomId);
      state.searching = false;
      if (firstActivation) send('', '/cancelsearch');
      return ensureBattle(roomId);
    }

    function shouldHandleBattle(roomId, line) {
      const key = battleRoomKey(roomId);
      if (state.completedBattleRooms.has(key)) return false;
      if (state.ignoredBattleRooms.has(key)) {
        if (line.startsWith('|win|') || line === '|tie') state.ignoredBattleRooms.delete(key);
        return false;
      }
      if (!state.activeBattleKey || state.activeBattleKey === key) return Boolean(activateBattle(roomId));
      ignoreExtraBattle(roomId);
      return false;
    }

    function ignoreExtraBattle(roomId) {
      const key = battleRoomKey(roomId);
      if (state.ignoredBattleRooms.has(key) || state.completedBattleRooms.has(key)) return;
      state.ignoredBattleRooms.add(key);
      send(roomId, '/forfeit');
      rememberCompletedBattleRoom(roomId);
      void recordIgnoredBattle(roomId).catch(error => {
        if (log) console.error(`Failed to record ignored battle ${roomId}: ${error?.stack ?? error}`);
      });
      void emitStatus({
        state: 'in-battle',
        searching: false,
        battleRoomId: state.activeBattleRoomId,
        lastEvent: `forfeited extra concurrent battle ${roomId}`,
      });
    }

    async function recordIgnoredBattle(roomId) {
      if (!onBattleEnd) return;
      const now = new Date().toISOString();
      await onBattleEnd({
        id: roomId,
        source: 'pokemon-showdown-live',
        startedAt: now,
        finishedAt: now,
        playerId: player.id,
        model: player.model ?? null,
        reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
        accountUsername: credentials.username,
        formatId: freeze.formatId,
        formatName: freeze.formatName,
        rated: true,
        roomId,
        replayUrl: null,
        replayUploaded: false,
        replaySaveError: 'forfeited extra concurrent battle',
        replaySaveTimedOut: false,
        sideId: null,
        player: {
          sideId: null,
          username: credentials.username,
          ratingBefore: null,
        },
        opponent: {
          sideId: null,
          username: null,
          ratingBefore: null,
        },
        winnerName: null,
        winnerIsModel: false,
        result: 'loss',
        tie: false,
        turns: 0,
        forcedForfeit: true,
        forcedForfeitReason: 'extra-concurrent-battle',
        stats: {
          choices: 0,
          invalidActions: 0,
          timeouts: 0,
          errors: 0,
        },
      });
    }

    function enableTimer(roomId, battle) {
      if (!roomId || battle.timerStarted) return;
      send(roomId, '/timer on');
      battle.timerStarted = true;
      void emitBattleStatus('in-battle', battle, 'timer enabled');
    }

    function ensureBattle(roomId) {
      const key = battleRoomKey(roomId);
      if (!state.battles.has(key)) {
        state.battles.set(key, {
          roomId,
          key,
          startedAt: new Date().toISOString(),
          sideId: null,
          turns: 0,
          winnerName: null,
          tie: false,
          rated: false,
          ended: false,
          timerStarted: false,
          pendingReplaySave: null,
          players: {},
          publicLog: [],
          stats: {
            choices: 0,
            invalidActions: 0,
            timeouts: 0,
            errors: 0,
          },
        });
      }
      const battle = state.battles.get(key);
      battle.roomId = preferBattleRoomId(battle.roomId, roomId);
      return battle;
    }

    async function emitBattleStatus(status, battle, lastEvent) {
      const opponent = opponentPlayerView(battle);
      await emitStatus({
        state: status,
        searching: false,
        battleRoomId: battle.roomId,
        battleStartedAt: battle.startedAt,
        battleTurns: battle.turns,
        opponent: opponent.username ? opponent : null,
        lastEvent,
      });
    }

    function rememberCompletedBattleRoom(roomId) {
      const key = battleRoomKey(roomId);
      state.completedBattleRooms.add(key);
      state.completedBattleRoomOrder.push(key);
      while (state.completedBattleRoomOrder.length > 500) {
        state.completedBattleRooms.delete(state.completedBattleRoomOrder.shift());
      }
    }
  });

  async function emitStatus(update) {
    if (!onStatus) return;
    const status = {
      source: 'pokemon-showdown-live',
      playerId: player.id,
      model: player.model ?? null,
      reasoningEffort: player.reasoningEffort ?? player.reasoning?.effort ?? null,
      accountUsername: credentials.username,
      formatId: freeze.formatId,
      ...lastStatus,
      gamesCompleted: state.gamesCompleted,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    lastStatus = status;
    try {
      statusQueue = statusQueue.catch(() => {}).then(() => onStatus(status));
      await statusQueue;
    } catch (error) {
      if (log) console.error(`Status update failed: ${error?.stack ?? error}`);
    }
  }
}

function battleRoomKey(roomId) {
  const match = String(roomId ?? '').match(/^(battle-[a-z0-9]+-\d+)(?:-[a-z0-9]+)?$/i);
  return match?.[1] ?? roomId;
}

function preferBattleRoomId(current, next) {
  if (!current) return next;
  if (battleRoomKey(current) !== battleRoomKey(next)) return current;
  return String(next).length > String(current).length ? next : current;
}

function extractReplayUrl(text) {
  const match = String(text ?? '').match(/https:\/\/replay\.pokemonshowdown\.com\/[a-z0-9-]+/i);
  return match?.[0] ?? null;
}

function popupText(line) {
  return String(line ?? '')
    .replace(/^\|popup\|/, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

export async function verifyShowdownLogin(options) {
  const {
    username,
    password,
    serverUrl = DEFAULT_SERVER_URL,
    loginUrl = DEFAULT_LOGIN_URL,
    timeoutMs = 15_000,
    WebSocketClass = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
  } = options;

  if (!username) throw new Error('Pokemon Showdown username is required.');
  if (!password) throw new Error('Pokemon Showdown password is required.');
  if (typeof WebSocketClass !== 'function') {
    throw new Error('Pokemon Showdown login check needs a Node.js runtime with global WebSocket support.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Pokemon Showdown login check needs a fetch implementation.');
  }

  const socket = new WebSocketClass(serverUrl);
  const expectedUserId = toId(username);
  let settled = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(reject, new Error(`Pokemon Showdown login check timed out for ${username}.`));
    }, timeoutMs);

    socket.addEventListener('error', event => {
      finish(reject, new Error(`Pokemon Showdown WebSocket error: ${event?.message ?? 'unknown error'}`));
    });
    socket.addEventListener('close', () => {
      if (!settled) finish(reject, new Error(`Pokemon Showdown WebSocket closed before ${username} logged in.`));
    });
    socket.addEventListener('message', event => {
      handleSocketMessage(String(event.data)).catch(error => finish(reject, error));
    });

    async function handleSocketMessage(raw) {
      for (const block of unpackSockJsFrame(raw)) {
        const parsed = parseRoomBlock(block);
        for (const line of parsed.lines) {
          if (line.startsWith('|challstr|')) {
            const challstr = line.slice('|challstr|'.length);
            const assertion = await requestAssertion({loginUrl, challstr, fetchImpl, username, password});
            socket.send(`|/trn ${username},0,${assertion}`);
          }
          if (line.startsWith('|updateuser|')) {
            const parts = line.split('|');
            const loggedInName = parts[2].trim();
            const named = parts[3] === '1';
            if (named && toId(loggedInName) === expectedUserId) {
              finish(resolve, {
                ok: true,
                username: loggedInName,
                userId: toId(loggedInName),
              });
            }
          }
          if (line.startsWith('|popup|')) {
            finish(reject, new Error(`Pokemon Showdown login popup for ${username}: ${line.slice('|popup|'.length)}`));
          }
        }
      }
    }

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // The socket may already be closing.
      }
      callback(value);
    }
  });
}

function handlePlayerLine(battle, line) {
  const [, , sideId, username, avatar, rating] = line.split('|');
  battle.players[sideId] = {
    sideId,
    username,
    userId: toId(username),
    avatar: avatar || null,
    ratingBefore: numberOrNull(rating),
  };
  battle.sideId ??= sideId;
}

function ownPlayerView(battle, accountUsername) {
  const accountUserId = toId(accountUsername);
  const fromName = Object.values(battle.players).find(entry => entry.userId === accountUserId);
  const fromSide = battle.sideId ? battle.players[battle.sideId] : null;
  const player = fromName ?? fromSide ?? {};
  return {
    sideId: player.sideId ?? battle.sideId,
    username: player.username ?? accountUsername,
    ratingBefore: player.ratingBefore ?? null,
  };
}

function opponentPlayerView(battle) {
  const opponent = Object.values(battle.players).find(entry => entry.sideId !== battle.sideId) ?? {};
  return {
    sideId: opponent.sideId ?? null,
    username: opponent.username ?? null,
    ratingBefore: opponent.ratingBefore ?? null,
  };
}

function resolveCredentials(player) {
  const account = player.showdownAccount ?? player.account ?? {};
  const username = account.username ?? (account.usernameEnv ? process.env[account.usernameEnv] : null);
  const password = account.password ?? (account.passwordEnv ? process.env[account.passwordEnv] : null);
  if (!username) throw new Error(`${player.id} is missing a Pokemon Showdown username.`);
  if (!password) throw new Error(`${player.id} is missing a Pokemon Showdown password.`);
  return {username, password};
}

async function requestAssertion({loginUrl, username, password, challstr, fetchImpl}) {
  const response = await fetchImpl(loginUrl, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      name: username,
      pass: password,
      challstr,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pokemon Showdown login failed with HTTP ${response.status}.`);
  }
  const data = JSON.parse(text.startsWith(']') ? text.slice(1) : text);
  if (!data.assertion) {
    const reason = data.error || data.message || data.actionerror || 'unknown reason';
    throw new Error(`Pokemon Showdown login did not return an assertion for ${username}: ${reason}`);
  }
  return data.assertion;
}

function unpackSockJsFrame(raw) {
  if (!raw || raw === 'o' || raw === 'h') return [];
  if (raw.startsWith('a')) return JSON.parse(raw.slice(1));
  if (raw.startsWith('c')) return [];
  return [raw];
}

function parseRoomBlock(block) {
  const lines = String(block).split('\n');
  let roomId = '';
  if (lines[0]?.startsWith('>')) roomId = lines.shift().slice(1);
  return {roomId, lines: lines.filter(Boolean)};
}

async function chooseWithTimeout(agent, context, timeoutMs, fallbackChoice = () => 'default') {
  let timeout;
  const controller = new AbortController();
  const timeoutPromise = new Promise(resolve => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({choice: fallbackChoice(), timeout: true});
    }, timeoutMs);
  });
  const choicePromise = Promise.resolve(agent.chooseAction({...context, signal: controller.signal}))
    .then(choice => ({choice, timeout: false}))
    .catch(error => ({choice: null, timeout: false, error}));
  const result = await Promise.race([choicePromise, timeoutPromise]);
  clearTimeout(timeout);
  return result;
}

function summarizeAgentError(error) {
  const message = String(error?.message ?? error ?? 'unknown agent error').replace(/\s+/g, ' ').trim();
  const apiMatch = message.match(/^OpenAI API error (\d+):\s*(\{.*\})$/);
  if (apiMatch) {
    try {
      const data = JSON.parse(apiMatch[2]);
      const details = data.error ?? {};
      const label = details.code ?? details.type ?? details.message ?? 'unknown_error';
      return `OpenAI API error ${apiMatch[1]}: ${label}`;
    } catch {
      return `OpenAI API error ${apiMatch[1]}`;
    }
  }
  return message.slice(0, 500);
}

function coerceChoice(choice, request, legalChoices, stats) {
  const normalized = normalizeChoice(choice);
  if (isLegalChoice(request, normalized)) return normalized;
  stats.invalidActions++;
  return legalChoices[0] ?? 'default';
}

function shouldLogLine(line) {
  return line.startsWith('|challstr|') ||
    line.startsWith('|updateuser|') ||
    line.startsWith('|updatesearch|') ||
    line.startsWith('|init|') ||
    line.startsWith('|turn|') ||
    line.startsWith('|win|') ||
    line.startsWith('|tie') ||
    line.startsWith('|error|') ||
    line.startsWith('|popup|');
}

function toId(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
