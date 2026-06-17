import assert from 'node:assert/strict';
import {runLiveLadderBot} from '../src/showdown/live-ladder.js';
import {loadFreeze} from '../src/showdown/freeze.js';

const freeze = await loadFreeze();
const records = [];
const statuses = [];
const primaryRoom = 'battle-gen9championsou-1';
const primaryAliasRoom = 'battle-gen9championsou-1-privatealias';
const extraRoom = 'battle-gen9championsou-2';

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.dispatch('open', {});
      this.receiveSock('|challstr|123|abcdef');
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message) {
    this.sent.push(message);
    if (message === '|/trn ArenaLLM,0,ASSERTION') {
      queueMicrotask(() => this.receiveSock('|updateuser| ArenaLLM|1|1|{}'));
      return;
    }
    if (message.startsWith('|/utm ')) return;
    if (message === `|/search ${freeze.formatId}`) {
      queueMicrotask(() => {
        this.receiveSock(`|updatesearch|${JSON.stringify({
          searching: [freeze.formatId],
          games: {
            [primaryRoom]: 'ArenaLLM vs Ladder Opponent',
            [primaryAliasRoom]: 'ArenaLLM vs Ladder Opponent',
            [extraRoom]: 'ArenaLLM vs Second Opponent',
          },
        })}`);
        this.receiveSock([
          `>${primaryAliasRoom}`,
          '|init|battle',
          '|player|p1|ArenaLLM|1|1500',
          '|player|p2|Ladder Opponent|1|1490',
          '|rated',
          '|turn|1',
          `|request|${JSON.stringify(teamPreviewRequest())}`,
        ].join('\n'));
        this.receiveSock([
          `>${extraRoom}`,
          '|init|battle',
          '|player|p1|ArenaLLM|1|1500',
          '|player|p2|Second Opponent|1|1490',
          '|turn|1',
          `|request|${JSON.stringify(teamPreviewRequest())}`,
        ].join('\n'));
      });
      return;
    }
    if (message.startsWith(`${primaryAliasRoom}|/choose team `)) {
      queueMicrotask(() => {
        this.receiveSock([
          `>${primaryAliasRoom}`,
          '|turn|2',
          '|win|ArenaLLM',
          '|player|p1|ArenaLLM|1|1517',
        ].join('\n'));
      });
    }
    if (message === `${primaryAliasRoom}|/savereplay`) {
      queueMicrotask(() => {
        this.receiveSock([
          `>${primaryAliasRoom}`,
          '|popup||html|<p>Your replay has been uploaded! It is available at:</p><p><a href="https://replay.pokemonshowdown.com/gen9championsou-1">https://replay.pokemonshowdown.com/gen9championsou-1</a></p>',
        ].join('\n'));
      });
    }
  }

  close() {
    queueMicrotask(() => this.dispatch('close', {}));
  }

  receiveSock(block) {
    this.dispatch('message', {data: `a[${JSON.stringify(block)}]`});
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const result = await runLiveLadderBot({
  player: {
    id: 'mock-model',
    name: 'Mock Model',
    type: 'random',
    model: 'mock',
    teamFile: 'data/teams/o3.txt',
    account: {
      username: 'ArenaLLM',
      password: 'not-a-real-password',
    },
  },
  freeze,
  games: 1,
  choiceTimeoutMs: 1_000,
  searchDelayMs: 1,
  WebSocketClass: MockWebSocket,
  fetchImpl: async (url, init) => {
    assert.equal(url, 'https://play.pokemonshowdown.com/api/login');
    assert.equal(init.method, 'POST');
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('name'), 'ArenaLLM');
    assert.equal(params.get('pass'), 'not-a-real-password');
    assert.equal(params.get('challstr'), '123|abcdef');
    return {
      ok: true,
      status: 200,
      text: async () => `]${JSON.stringify({assertion: 'ASSERTION'})}`,
    };
  },
  onBattleEnd: record => {
    records.push(record);
  },
  onStatus: status => {
    statuses.push(status);
  },
});

const socket = MockWebSocket.instances[0];
assert.equal(result.gamesCompleted, 1);
assert.equal(records.length, 2);
const primaryRecord = records.find(record => record.roomId === primaryAliasRoom);
const extraRecord = records.find(record => record.roomId === extraRoom);
assert.ok(primaryRecord);
assert.ok(extraRecord);
assert.equal(primaryRecord.result, 'win');
assert.equal(primaryRecord.winnerIsModel, true);
assert.equal(primaryRecord.player.username, 'ArenaLLM');
assert.equal(primaryRecord.opponent.username, 'Ladder Opponent');
assert.equal(primaryRecord.player.ratingBefore, 1500);
assert.equal(primaryRecord.opponent.ratingBefore, 1490);
assert.equal(primaryRecord.rated, true);
assert.equal(primaryRecord.turns, 2);
assert.equal(primaryRecord.stats.choices, 1);
assert.equal(primaryRecord.replayUploaded, true);
assert.equal(primaryRecord.replayUrl, 'https://replay.pokemonshowdown.com/gen9championsou-1');
assert.equal(extraRecord.result, 'loss');
assert.equal(extraRecord.winnerIsModel, false);
assert.equal(extraRecord.forcedForfeit, true);
assert.equal(extraRecord.forcedForfeitReason, 'extra-concurrent-battle');
assert.equal(extraRecord.player.username, 'ArenaLLM');
assert.equal(extraRecord.replayUploaded, false);
assert.ok(socket.sent.some(message => message.startsWith('|/utm ')));
assert.ok(socket.sent.includes(`|/search ${freeze.formatId}`));
assert.equal(socket.sent.filter(message => message === '|/cancelsearch').length, 2);
assert.equal(socket.sent.filter(message => message === `${primaryAliasRoom}|/timer on`).length, 1);
assert.equal(socket.sent.filter(message => message === `${primaryAliasRoom}|/savereplay`).length, 1);
assert.equal(socket.sent.filter(message => message === `${primaryAliasRoom}|/forfeit`).length, 0);
assert.equal(socket.sent.filter(message => message === `${extraRoom}|/timer on`).length, 0);
assert.equal(socket.sent.filter(message => message === `${extraRoom}|/forfeit`).length, 1);
assert.ok(socket.sent.some(message => message.startsWith(`${primaryAliasRoom}|/choose team `)));
assert.equal(socket.sent.some(message => message.startsWith(`${extraRoom}|/choose `)), false);
assert.ok(socket.sent.includes('|/cancelsearch'));
assert.ok(statuses.some(status => status.state === 'searching'));
assert.ok(statuses.some(status => status.state === 'in-battle' && status.battleRoomId === primaryAliasRoom));
assert.ok(statuses.some(status => status.state === 'choosing'));
assert.ok(statuses.some(status => status.state === 'battle-ended' && status.lastEvent === 'battle ended: win'));
const battleEndedIndex = statuses.findIndex(status => status.state === 'battle-ended');
assert.ok(battleEndedIndex >= 0);
assert.equal(
  statuses.slice(battleEndedIndex + 1).some(status => status.state === 'in-battle' && status.battleRoomId === primaryAliasRoom),
  false
);

const agentErrorRecords = [];
const agentErrorStatuses = [];
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'test-key';

class AgentErrorWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    AgentErrorWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.dispatch('open', {});
      this.receiveSock('|challstr|456|abcdef');
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message) {
    this.sent.push(message);
    if (message === '|/trn ArenaLLM,0,ASSERTION') {
      queueMicrotask(() => this.receiveSock('|updateuser| ArenaLLM|1|1|{}'));
      return;
    }
    if (message.startsWith('|/utm ')) return;
    if (message === `|/search ${freeze.formatId}`) {
      queueMicrotask(() => {
        this.receiveSock(`|updatesearch|${JSON.stringify({
          searching: [],
          games: {[primaryRoom]: 'ArenaLLM vs Ladder Opponent'},
        })}`);
        this.receiveSock([
          `>${primaryRoom}`,
          '|init|battle',
          '|player|p1|ArenaLLM|1|1500',
          '|player|p2|Ladder Opponent|1|1490',
          '|rated',
          '|turn|1',
          `|request|${JSON.stringify(moveRequest())}`,
        ].join('\n'));
      });
    }
  }

  close() {
    queueMicrotask(() => this.dispatch('close', {}));
  }

  receiveSock(block) {
    this.dispatch('message', {data: `a[${JSON.stringify(block)}]`});
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

globalThis.fetch = async url => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  return {
    ok: false,
    status: 429,
    json: async () => ({
      error: {
        message: 'You exceeded your current quota.',
        code: 'insufficient_quota',
        type: 'insufficient_quota',
      },
    }),
  };
};

try {
  await assert.rejects(
    runLiveLadderBot({
      player: {
        id: 'mock-openai',
        name: 'Mock OpenAI',
        type: 'openai',
        model: 'gpt-test',
        teamFile: 'data/teams/o3.txt',
        account: {
          username: 'ArenaLLM',
          password: 'not-a-real-password',
        },
      },
      freeze,
      games: 1,
      choiceTimeoutMs: 1_000,
      searchDelayMs: 1,
      WebSocketClass: AgentErrorWebSocket,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => `]${JSON.stringify({assertion: 'ASSERTION'})}`,
      }),
      onBattleEnd: record => {
        agentErrorRecords.push(record);
      },
      onStatus: status => {
        agentErrorStatuses.push(status);
      },
    }),
    error => {
      assert.equal(error.exitCode, 75);
      assert.match(error.message, /insufficient_quota/);
      return true;
    }
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
}

const agentErrorSocket = AgentErrorWebSocket.instances[0];
assert.equal(agentErrorRecords.length, 1);
assert.equal(agentErrorRecords[0].result, 'loss');
assert.equal(agentErrorRecords[0].forcedForfeit, true);
assert.equal(agentErrorRecords[0].forcedForfeitReason, 'agent-decision-error');
assert.equal(agentErrorRecords[0].stats.errors, 1);
assert.equal(agentErrorRecords[0].stats.choices, 0);
assert.ok(agentErrorSocket.sent.includes('|/cancelsearch'));
assert.ok(agentErrorSocket.sent.includes(`${primaryRoom}|/forfeit`));
assert.equal(agentErrorSocket.sent.some(message => message.startsWith(`${primaryRoom}|/choose `)), false);
assert.ok(agentErrorStatuses.some(status => status.state === 'error' && /insufficient_quota/.test(status.agentError)));

console.log(JSON.stringify({
  ok: true,
  gamesCompleted: result.gamesCompleted,
  record: {
    result: primaryRecord.result,
    winnerIsModel: primaryRecord.winnerIsModel,
    choices: primaryRecord.stats.choices,
  },
}, null, 2));

function teamPreviewRequest() {
  return {
    rqid: 1,
    teamPreview: true,
    side: {
      id: 'p1',
      name: 'ArenaLLM',
      pokemon: Array.from({length: 6}, (_, index) => ({
        ident: `p1: Pokemon ${index + 1}`,
        details: `Pokemon ${index + 1}`,
        condition: '100/100',
        active: false,
        stats: {},
        moves: [],
      })),
    },
  };
}

function moveRequest() {
  return {
    rqid: 2,
    active: [{
      moves: [{
        move: 'Return',
        id: 'return',
        pp: 20,
        maxpp: 20,
        disabled: false,
        target: 'normal',
      }],
    }],
    side: {
      id: 'p1',
      name: 'ArenaLLM',
      pokemon: [
        {
          ident: 'p1: Lopunny',
          details: 'Lopunny, L50',
          condition: '100/100',
          active: true,
          stats: {},
          moves: ['return'],
        },
        {
          ident: 'p1: Tyranitar',
          details: 'Tyranitar, L50',
          condition: '100/100',
          active: false,
          stats: {},
          moves: [],
        },
      ],
    },
  };
}
