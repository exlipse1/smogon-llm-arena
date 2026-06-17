import {mulberry32} from '../core/rng.js';
import {RandomAgent} from './random.js';
import {HeuristicAgent} from './heuristic.js';
import {OpenAiPokemonAgent} from './openai.js';

export function createAgent(spec, seed = 1) {
  const type = spec.type ?? 'random';
  if (type === 'random') return new RandomAgent({seededRandom: mulberry32(seed)});
  if (type === 'heuristic') return new HeuristicAgent({seededRandom: mulberry32(seed)});
  if (type === 'openai') {
    return new OpenAiPokemonAgent({
      model: spec.model,
      reasoningEffort: spec.reasoningEffort ?? spec.reasoning?.effort,
    });
  }
  throw new Error(`Unknown agent type: ${type}`);
}
