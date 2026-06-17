import {loadDotEnv} from '../src/core/env.js';
import {loadFreeze} from '../src/showdown/freeze.js';
import {validateTeam} from '../src/showdown/teams.js';
import {readTextMaybeRoot, writeText, writeJson} from '../src/core/fs.js';
import {OpenAiPokemonAgent} from '../src/agents/openai.js';
import {runTournament} from '../src/tournament.js';

await loadDotEnv();

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is missing. Add it to smogon-llm-arena/.env or export it in the shell, then rerun this command.');
}

const args = parseArgs(process.argv.slice(2));
const model = args.model ?? process.env.OPENAI_MODEL ?? 'gpt-5.5';
const teamOut = args.teamOut ?? args['team-out'] ?? 'data/teams/gpt-5.5.txt';
const resultOut = args.out ?? 'results/gpt-5.5-champion.json';
const manifest = args.manifest ?? 'config/benchmark.gpt-5.5.json';
const attempts = Number(args.attempts ?? 3);
const reasoningEffort = args.reasoningEffort ?? args['reasoning-effort'] ?? process.env.OPENAI_REASONING_EFFORT ?? null;

const freeze = await loadFreeze();
const agent = new OpenAiPokemonAgent({model, reasoningEffort});

console.log(`Building ${model} team for ${freeze.formatName}${reasoningEffort ? ` with ${reasoningEffort} reasoning` : ''}...`);
const team = await agent.buildTeam({formatName: freeze.formatName, freeze, attempts});
const validation = validateTeam(freeze.formatName, team);
if (!validation.valid) {
  throw new Error(`Generated team failed validation:\n${validation.problems.join('\n')}`);
}
await writeText(teamOut, team);
console.log(`Wrote validated team to ${teamOut}.`);

console.log(`Running tournament manifest ${manifest}...`);
const summary = await runTournament({manifestPath: manifest, outPath: resultOut});

const teamText = await readTextMaybeRoot(teamOut);
await writeJson('results/gpt-5.5-team-validation.json', {
  model,
  reasoningEffort,
  teamFile: teamOut,
  validation: validateTeam(freeze.formatName, teamText),
});

console.log(JSON.stringify({
  resultOut,
  ratings: summary.ratings,
  games: summary.games.length,
}, null, 2));

function parseArgs(rawArgs) {
  const args = {};
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else {
      args[key] = rawArgs[index + 1];
      index++;
    }
  }
  return args;
}
