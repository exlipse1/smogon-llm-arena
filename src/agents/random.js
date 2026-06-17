import {sample} from '../core/rng.js';

export class RandomAgent {
  constructor({seededRandom = Math.random} = {}) {
    this.random = seededRandom;
  }

  async chooseAction(context) {
    if (context.request?.teamPreview) return randomTeamOrder(context, this.random);
    return sample(context.legalChoices.length ? context.legalChoices : ['default'], this.random);
  }
}

function randomTeamOrder(context, random) {
  const teamSize = context.request?.side?.pokemon?.length ?? 6;
  const slots = Array.from({length: teamSize}, (_, index) => index + 1);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return `team ${slots.join('')}`;
}
