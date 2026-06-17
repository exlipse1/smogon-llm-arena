#!/usr/bin/env node
import crypto from 'node:crypto';
import {loadDotEnv} from '../src/core/env.js';

await loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env[args.apiKeyEnv ?? args['api-key-env'] ?? 'OPENAI_API_KEY'];
const organization = args.organization ?? args.org ?? process.env.OPENAI_ORG_ID ?? process.env.OPENAI_ORGANIZATION ?? null;
const project = args.project ?? process.env.OPENAI_PROJECT_ID ?? process.env.OPENAI_PROJECT ?? null;
const models = String(args.models ?? 'gpt-5.2,gpt-5.4,gpt-5.5')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const reasoningEffort = args.reasoningEffort ?? args['reasoning-effort'] ?? 'medium';

if (!apiKey) throw new Error('OPENAI_API_KEY is missing.');

const headers = {
  authorization: `Bearer ${apiKey}`,
  'content-type': 'application/json',
};
if (organization) headers['OpenAI-Organization'] = organization;
if (project) headers['OpenAI-Project'] = project;

const listedModels = await listModels(headers);
const probes = [];
for (const model of models) probes.push(await probeModel({headers, model, reasoningEffort}));

console.log(JSON.stringify({
  ok: probes.every(probe => probe.ok),
  apiKeyHash: crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12),
  requestContext: {
    organization: organization ? maskIdentifier(organization) : null,
    project: project ? maskIdentifier(project) : null,
  },
  listedModels: {
    status: listedModels.status,
    count: listedModels.ids.length,
    matching: listedModels.ids.filter(id => models.includes(id)),
    gpt5: listedModels.ids.filter(id => /^gpt-5/.test(id)).sort(),
  },
  probes,
}, null, 2));

async function listModels(headers) {
  const response = await fetch('https://api.openai.com/v1/models', {headers});
  const data = await response.json().catch(() => ({}));
  return {
    status: response.status,
    ids: (data.data ?? []).map(model => model.id).filter(Boolean),
  };
}

async function probeModel({headers, model, reasoningEffort}) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      reasoning: {effort: reasoningEffort},
      input: 'Reply with exactly OK.',
      max_output_tokens: 32,
    }),
  });
  const data = await response.json().catch(() => ({}));
  return {
    model,
    ok: response.ok,
    status: response.status,
    requestId: response.headers.get('x-request-id'),
    organization: response.headers.get('openai-organization'),
    error: data.error ? {
      message: data.error.message,
      code: data.error.code,
      type: data.error.type,
    } : null,
  };
}

function maskIdentifier(value) {
  const text = String(value);
  if (text.length <= 10) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = rawArgs[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}
