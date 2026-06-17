import {validateTeam} from '../showdown/teams.js';
import {readTextMaybeRoot} from '../core/fs.js';
import {LADDER_TIMER_POLICY} from '../core/timer.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const VALID_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const TIMER_GUIDANCE = [
  'Ladder battles use a total timer, so move promptly.',
  'The total timer starts at 210 seconds, loses 5 seconds per tick, gains only 10 seconds per turn, and is capped at 210 seconds.',
  'The current-turn timer is capped at 150 seconds.',
  'You lose if either timer reaches 0.',
  'Slow choices spend future time bank; if the position is unclear, pick a reasonable legal choice quickly.',
].join(' ');
const SPECIAL_MECHANIC_GUIDANCE = [
  'Some legal choices may include Mega Evolution suffixes: mega, megax, or megay.',
  'These suffixes Mega evolve while using the selected move; return the full legal choice string when you want Mega Evolution.',
  'Do not ask for Ultra Burst, Z-Moves, Dynamax, or Terastallization; they are not part of this format.',
  'If Lopunny can Mega evolve, it is usually best to choose a legal "move N mega" early unless there is a clear tactical reason to delay.',
].join(' ');

export class OpenAiPokemonAgent {
  constructor({
    model = process.env.OPENAI_MODEL ?? 'gpt-5.5',
    apiKey = process.env.OPENAI_API_KEY,
    organization = process.env.OPENAI_ORG_ID ?? process.env.OPENAI_ORGANIZATION ?? null,
    project = process.env.OPENAI_PROJECT_ID ?? process.env.OPENAI_PROJECT ?? null,
    reasoningEffort = null,
  } = {}) {
    this.model = model;
    this.apiKey = apiKey;
    this.organization = normalizeOptionalHeaderValue(organization);
    this.project = normalizeOptionalHeaderValue(project);
    this.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
  }

  async chooseAction(context) {
    const response = await this.callModel({
      system: [
        'You are playing a competitive Pokemon Showdown battle.',
        'Return exactly one legal choice string from the provided legalChoices list.',
        'Do not explain. Do not invent moves. Do not include markdown.',
        TIMER_GUIDANCE,
        SPECIAL_MECHANIC_GUIDANCE,
      ].join(' '),
      user: JSON.stringify({
        format: context.formatName,
        side: context.sideId,
        turn: context.turn,
        legalChoices: context.legalChoices,
        timerPolicy: LADDER_TIMER_POLICY,
        timerStatus: context.timer ?? null,
        request: context.request,
        recentPublicLog: context.publicLog,
      }, null, 2),
    });
    return extractChoice(response, context.legalChoices);
  }

  async buildTeam({formatName, freeze, attempts = 3}) {
    let feedback = '';
    const legalExample = await readLegalExample();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const teamText = await this.callModel({
        system: [
          'You build legal competitive Pokemon Showdown teams.',
          'Return only one Pokemon Showdown importable team.',
          'The team must have exactly six Pokemon and must be legal for the requested format.',
          'This is NOT standard OU teambuilding.',
          'For [Gen 9 Champions] OU, EVs are Champions stat points, not normal 508 EV spreads.',
          'Each Pokemon must have at most 66 total EV/stat points and no stat may exceed 32.',
          'Do not set IVs; the format requires max IVs.',
          'Many standard Gen 9 OU Pokemon, moves, and items are illegal here, so prefer the legal example pool unless you are certain.',
          'For this benchmark season, use only the exact six sets from the legal example pool.',
          'You may reorder the six Pokemon, but do not change species, items, abilities, EVs, natures, or moves.',
          'Do not add Great Tusk, Landorus, Iron Valiant, Choice Specs, or any other non-example choice.',
          'If validation feedback is provided, repair every listed issue before changing anything else.',
          'Do not include markdown fences or commentary.',
        ].join(' '),
        user: JSON.stringify({
          formatName,
          frozenFormat: freeze,
          hardLegalityConstraints: [
            'Exactly six Pokemon.',
            'Use Pokemon Showdown importable text only.',
            'Use Champions stat points in EVs; total EV/stat points per Pokemon must be <= 66.',
            'No individual EV/stat point value may exceed 32.',
            'Do not use standard 252/508 EV spreads.',
            'Do not include IV lines.',
            'Use only legal Pokemon, abilities, items, and moves for [Gen 9 Champions] OU.',
            'For this run, use only the exact sets in legalExample. Reordering is allowed; changing a set is not.',
          ],
          legalExample,
          previousValidationFeedback: feedback || null,
        }, null, 2),
      });
      const cleaned = stripMarkdownFences(teamText);
      const validation = validateTeam(formatName, cleaned);
      if (validation.valid) return cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`;
      feedback = validation.problems.join('\n');
    }
    throw new Error(`Model did not produce a valid team after ${attempts} attempts.\n${feedback}`);
  }

  async callModel({system, user}) {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required for the OpenAI agent.');
    }

    const body = {
      model: this.model,
      input: [
        {role: 'system', content: system},
        {role: 'user', content: user},
      ],
    };
    if (this.reasoningEffort) body.reasoning = {effort: this.reasoningEffort};

    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`OpenAI API error ${response.status}: ${JSON.stringify(data)}`);
    }
    return outputText(data);
  }

  headers() {
    const headers = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
    if (this.organization) headers['OpenAI-Organization'] = this.organization;
    if (this.project) headers['OpenAI-Project'] = this.project;
    return headers;
  }
}

function normalizeReasoningEffort(value) {
  if (value === null || value === undefined || value === '') return null;
  const effort = String(value).trim();
  if (!VALID_REASONING_EFFORTS.has(effort)) {
    throw new Error(`Unsupported reasoning effort: ${effort}`);
  }
  return effort;
}

function normalizeOptionalHeaderValue(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

async function readLegalExample() {
  try {
    return await readTextMaybeRoot('data/teams/baseline.txt');
  } catch {
    return null;
  }
}

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text);
      if (typeof content.output_text === 'string') parts.push(content.output_text);
    }
  }
  return parts.join('\n').trim();
}

function extractChoice(text, legalChoices) {
  const trimmed = stripMarkdownFences(text).trim();
  if (legalChoices.includes(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const choice of legalChoices) {
    if (choice.toLowerCase() === lower) return choice;
  }
  const quoted = trimmed.match(/"([^"]+)"/)?.[1];
  if (quoted) return quoted;
  return trimmed.split('\n')[0].trim();
}

function stripMarkdownFences(text) {
  return String(text ?? '')
    .replace(/^```(?:text|txt|pokemon|showdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
