import assert from 'node:assert/strict';
import {createAgent} from '../src/agents/factory.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
let requestBody = null;

process.env.OPENAI_API_KEY = 'test-key';
globalThis.fetch = async (_url, options) => {
  requestBody = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => ({output_text: 'move 1 mega'}),
  };
};

try {
  const agent = createAgent({
    type: 'openai',
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
  });
  const choice = await agent.chooseAction({
    formatName: '[Gen 9 Champions] OU',
    sideId: 'p1',
    turn: 1,
    legalChoices: ['move 1', 'move 1 mega'],
    request: {active: [{}], secondsLeft: 185, turnSecondsLeft: 145},
    timer: {secondsLeft: 185, turnSecondsLeft: 145, source: 'request'},
    publicLog: [],
  });

  assert.equal(choice, 'move 1 mega');
  assert.equal(requestBody.model, 'gpt-5.4');
  assert.deepEqual(requestBody.reasoning, {effort: 'medium'});
  assert.match(requestBody.input[0].content, /total timer/i);
  assert.match(requestBody.input[0].content, /210 seconds/i);
  assert.match(requestBody.input[0].content, /mega/i);
  assert.match(requestBody.input[0].content, /not part of this format/i);
  const userPayload = JSON.parse(requestBody.input[1].content);
  assert.equal(userPayload.timerPolicy.totalTimer.startsAtSeconds, 210);
  assert.equal(userPayload.timerPolicy.totalTimer.gainsSecondsPerTurn, 10);
  assert.equal(userPayload.timerPolicy.turnTimer.capSeconds, 150);
  assert.deepEqual(userPayload.timerStatus, {secondsLeft: 185, turnSecondsLeft: 145, source: 'request'});
} finally {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
}

console.log(JSON.stringify({ok: true, reasoningEffort: requestBody?.reasoning?.effort ?? null}, null, 2));
