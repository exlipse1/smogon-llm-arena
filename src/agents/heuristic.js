import {RandomAgent} from './random.js';
import {loadShowdown} from '../showdown/load.js';

export class HeuristicAgent extends RandomAgent {
  async chooseAction(context) {
    if (context.request?.teamPreview) return super.chooseAction(context);

    const legalMoves = context.legalChoices.filter(choice => choice.startsWith('move '));
    if (!legalMoves.length) return super.chooseAction(context);

    const {Dex} = loadShowdown();
    const dex = Dex.mod('champions');
    let bestChoice = legalMoves[0];
    let bestScore = -Infinity;
    for (const choice of legalMoves) {
      const slot = Number(choice.split(/\s+/)[1]) - 1;
      const move = context.request?.active?.[0]?.moves?.[slot];
      const dexMove = dex.moves.get(move?.move ?? move?.id ?? '');
      const score = scoreMove(dexMove, move);
      if (score > bestScore) {
        bestScore = score;
        bestChoice = choice;
      }
    }
    return bestChoice;
  }
}

function scoreMove(dexMove, requestMove) {
  if (!dexMove?.exists) return 0;
  if (dexMove.id === 'struggle') return 1;
  let score = dexMove.basePower || 0;
  if (dexMove.category === 'Status') score = statusMoveScore(dexMove);
  if (requestMove?.pp <= 1) score -= 10;
  if (dexMove.accuracy && typeof dexMove.accuracy === 'number') score *= dexMove.accuracy / 100;
  return score;
}

function statusMoveScore(move) {
  if (['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(move.id)) return 70;
  if (['swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'quiverdance'].includes(move.id)) return 60;
  if (['recover', 'roost', 'slackoff', 'softboiled', 'moonlight', 'synthesis'].includes(move.id)) return 35;
  if (['protect', 'substitute', 'willowisp', 'toxic', 'thunderwave'].includes(move.id)) return 30;
  return 10;
}
