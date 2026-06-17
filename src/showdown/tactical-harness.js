import {loadShowdown} from './load.js';
import {timerStatusForPrompt, LADDER_TIMER_POLICY} from '../core/timer.js';

const NORMAL_DECISION_TIMEOUT_MS = 10_000;
const LOW_TIMER_DECISION_TIMEOUT_MS = 5_000;
const CRITICAL_TIMER_DECISION_TIMEOUT_MS = 2_500;

export function buildTacticalContext({freeze, battle, player, request, legalChoices}) {
  const timer = timerStatusForPrompt({request, publicLog: battle.publicLog});
  const dex = loadShowdown().Dex.mod('champions');
  const ownSideId = request.side?.id ?? battle.sideId;
  const opponentSideId = ownSideId === 'p1' ? 'p2' : 'p1';
  const ownActive = activePokemonFromRequest(request, dex);
  const ownBench = (request.side?.pokemon ?? [])
    .map((pokemon, index) => pokemonSummaryFromRequest(pokemon, index, dex))
    .filter(pokemon => !pokemon.active);
  const opponent = opponentStateFromLog(battle.publicLog, opponentSideId, dex);
  const annotatedChoices = annotateChoices({request, legalChoices, ownActive, opponent, timer, dex});

  return {
    formatId: freeze.formatId,
    formatName: freeze.formatName,
    sideId: ownSideId,
    playerId: player.id,
    opponentId: 'ladder-opponent',
    turn: battle.turns,
    request: compactRequest(request),
    legalChoices,
    timerPolicy: LADDER_TIMER_POLICY,
    timer,
    battleState: {
      turn: battle.turns,
      own: {
        sideId: ownSideId,
        active: ownActive,
        bench: ownBench,
      },
      opponent,
      timer,
    },
    annotatedChoices,
    publicLog: battle.publicLog.slice(-24),
  };
}

export function decisionTimeoutForContext(context, defaultTimeoutMs = NORMAL_DECISION_TIMEOUT_MS) {
  const secondsLeft = Number(context.timer?.secondsLeft ?? Infinity);
  const turnSecondsLeft = Number(context.timer?.turnSecondsLeft ?? Infinity);
  const available = Math.min(secondsLeft, turnSecondsLeft);
  if (Number.isFinite(available)) {
    if (available <= 15) return Math.min(defaultTimeoutMs, CRITICAL_TIMER_DECISION_TIMEOUT_MS);
    if (available <= 45) return Math.min(defaultTimeoutMs, LOW_TIMER_DECISION_TIMEOUT_MS);
  }
  return Math.min(defaultTimeoutMs, NORMAL_DECISION_TIMEOUT_MS);
}

export function fallbackChoiceForContext(context) {
  if (context.request?.teamPreview) return context.legalChoices[0] ?? 'default';
  const choices = context.annotatedChoices ?? [];
  const best = choices
    .filter(choice => choice.legal)
    .sort((a, b) => Number(b.fallbackScore ?? 0) - Number(a.fallbackScore ?? 0))[0];
  return best?.choice ?? context.legalChoices[0] ?? 'default';
}

export function annotateChoices({request, legalChoices, ownActive, opponent, timer, dex = loadShowdown().Dex.mod('champions')}) {
  return legalChoices.map(choice => annotateChoice({choice, request, ownActive, opponent, timer, dex}));
}

function annotateChoice({choice, request, ownActive, opponent, timer, dex}) {
  if (choice.startsWith('move ')) return annotateMoveChoice({choice, request, ownActive, opponent, timer, dex});
  if (choice.startsWith('switch ')) return annotateSwitchChoice({choice, request});
  if (choice.startsWith('team ')) {
    return {
      choice,
      legal: true,
      kind: 'team-preview',
      label: `Team preview order ${choice.slice('team '.length)}`,
      fallbackScore: 1,
      notes: ['required team preview order'],
    };
  }
  return {
    choice,
    legal: true,
    kind: 'other',
    label: choice,
    fallbackScore: 0,
    notes: [],
  };
}

function annotateMoveChoice({choice, request, ownActive, opponent, timer, dex}) {
  const parts = choice.split(/\s+/);
  const slot = Number(parts[1]);
  const suffix = parts.slice(2).join(' ') || null;
  const requestMove = request.active?.[0]?.moves?.[slot - 1] ?? {};
  const dexMove = dex.moves.get(requestMove.move ?? requestMove.id ?? '');
  const moveType = dexMove.type ?? requestMove.type ?? '???';
  const effectiveness = opponent.active?.types?.length
    ? typeEffectiveness(dex, moveType, opponent.active.types)
    : null;
  const stab = ownActive?.types?.includes(moveType) || Boolean(dexMove.forceSTAB);
  const basePower = displayBasePower(dexMove);
  const fallbackScore = scoreMoveChoice({dexMove, requestMove, effectiveness, stab, suffix, timer});
  const notes = [];
  if (suffix) notes.push(`uses ${suffix}`);
  if (stab) notes.push('STAB');
  if (effectiveness?.multiplier === 0) notes.push('no effect on known active type');
  else if (effectiveness?.multiplier > 1) notes.push(`${effectiveness.multiplier}x effective`);
  else if (effectiveness?.multiplier && effectiveness.multiplier < 1) notes.push(`${effectiveness.multiplier}x resisted`);
  if (isTimerLow(timer)) notes.push('timer low: prefer prompt legal action');

  return {
    choice,
    legal: true,
    kind: 'move',
    slot,
    label: `${suffix ? `${mechanicLabel(suffix)} + ` : ''}${dexMove.name || requestMove.move || `move ${slot}`}`,
    move: {
      name: dexMove.name || requestMove.move || null,
      id: dexMove.id || requestMove.id || null,
      type: moveType,
      category: dexMove.category ?? null,
      basePower,
      accuracy: dexMove.accuracy ?? null,
      priority: Number(dexMove.priority ?? 0),
      pp: requestMove.pp,
      maxpp: requestMove.maxpp,
      target: dexMove.target ?? requestMove.target ?? null,
    },
    mechanics: suffix ? [suffix] : [],
    estimates: {
      stab,
      typeEffectiveness: effectiveness,
    },
    fallbackScore,
    notes,
  };
}

function annotateSwitchChoice({choice, request}) {
  const slot = Number(choice.split(/\s+/)[1]);
  const pokemon = request.side?.pokemon?.[slot - 1];
  const hp = hpPercent(pokemon?.condition);
  return {
    choice,
    legal: true,
    kind: 'switch',
    slot,
    label: `Switch to ${pokemonName(pokemon?.ident ?? pokemon?.details ?? `slot ${slot}`)}`,
    pokemon: {
      slot,
      ident: pokemon?.ident,
      details: pokemon?.details,
      condition: pokemon?.condition,
      hpPercent: hp,
      item: pokemon?.item,
      ability: pokemon?.ability ?? pokemon?.baseAbility,
      moves: pokemon?.moves,
    },
    fallbackScore: 20 + (hp ?? 0) * 0.35,
    notes: hp !== null ? [`${Math.round(hp)}% HP`] : [],
  };
}

function scoreMoveChoice({dexMove, requestMove, effectiveness, stab, suffix, timer}) {
  if (!dexMove?.exists) return 1;
  if (effectiveness?.multiplier === 0) return 0.1;

  let score = displayBasePower(dexMove);
  if (dexMove.category === 'Status') score = statusMoveScore(dexMove);
  if (dexMove.id === 'struggle') score = 1;
  if (stab) score *= 1.25;
  if (effectiveness?.multiplier) score *= effectiveness.multiplier;
  if (typeof dexMove.accuracy === 'number') score *= Math.max(0.55, dexMove.accuracy / 100);
  score += Number(dexMove.priority ?? 0) * 8;
  if (suffix === 'mega' || suffix === 'megax' || suffix === 'megay') score += 35;
  if (requestMove?.pp <= 1) score -= 10;
  if (isTimerLow(timer)) score += 4;
  return Math.round(score * 10) / 10;
}

function statusMoveScore(move) {
  if (['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(move.id)) return 72;
  if (['swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'quiverdance'].includes(move.id)) return 64;
  if (['recover', 'roost', 'slackoff', 'softboiled', 'moonlight', 'synthesis'].includes(move.id)) return 38;
  if (['willowisp', 'toxic', 'thunderwave', 'glare', 'spore', 'sleeppowder'].includes(move.id)) return 36;
  if (['protect', 'substitute'].includes(move.id)) return 24;
  return 12;
}

function displayBasePower(move) {
  if (!move?.exists) return 0;
  if (move.basePower) return move.basePower;
  if (move.id === 'return' || move.id === 'frustration') return 102;
  if (move.damage || move.damageCallback) return 80;
  return 0;
}

function typeEffectiveness(dex, moveType, targetTypes) {
  let multiplier = 1;
  const details = [];
  for (const type of targetTypes) {
    const immune = dex.getImmunity(moveType, type);
    const modifier = dex.getEffectiveness(moveType, type);
    const typeMultiplier = immune ? Math.pow(2, modifier) : 0;
    multiplier *= typeMultiplier;
    details.push({type, multiplier: typeMultiplier});
  }
  return {
    multiplier,
    label: multiplier === 0 ? 'immune' : `${multiplier}x`,
    targetTypes,
    details,
  };
}

function activePokemonFromRequest(request, dex) {
  const pokemon = request.side?.pokemon?.find(entry => entry.active) ?? null;
  return pokemon ? pokemonSummaryFromRequest(pokemon, request.side?.pokemon?.indexOf(pokemon) ?? 0, dex) : null;
}

function pokemonSummaryFromRequest(pokemon, index, dex) {
  const species = speciesFromDetails(pokemon.details);
  const dexSpecies = dex.species.get(species);
  return {
    slot: index + 1,
    ident: pokemon.ident,
    name: pokemonName(pokemon.ident ?? species),
    species,
    types: dexSpecies.exists ? dexSpecies.types : [],
    condition: pokemon.condition,
    hpPercent: hpPercent(pokemon.condition),
    active: Boolean(pokemon.active),
    stats: pokemon.stats,
    moves: pokemon.moves,
    ability: pokemon.ability ?? pokemon.baseAbility,
    item: pokemon.item,
  };
}

function opponentStateFromLog(publicLog, opponentSideId, dex) {
  const active = latestActiveFromLog(publicLog, opponentSideId, dex);
  return {
    sideId: opponentSideId,
    active,
    revealedMoves: revealedMovesFromLog(publicLog, opponentSideId),
  };
}

function latestActiveFromLog(publicLog, sideId, dex) {
  const prefix = `${sideId}a:`;
  for (const line of [...publicLog].reverse()) {
    if (!line.startsWith('|switch|') && !line.startsWith('|drag|') && !line.startsWith('|replace|')) continue;
    const parts = line.split('|');
    const ident = parts[2] ?? '';
    if (!ident.startsWith(prefix)) continue;
    const details = parts[3] ?? '';
    const condition = parts[4] ?? null;
    const species = speciesFromDetails(details || ident);
    const dexSpecies = dex.species.get(species);
    return {
      ident,
      name: pokemonName(ident),
      species,
      details,
      types: dexSpecies.exists ? dexSpecies.types : [],
      condition,
      hpPercent: hpPercent(condition),
    };
  }
  return null;
}

function revealedMovesFromLog(publicLog, sideId) {
  const prefix = `${sideId}a:`;
  const moves = new Set();
  for (const line of publicLog) {
    if (!line.startsWith('|move|')) continue;
    const parts = line.split('|');
    const ident = parts[2] ?? '';
    if (ident.startsWith(prefix) && parts[3]) moves.add(parts[3]);
  }
  return [...moves].slice(-8);
}

function compactRequest(request) {
  return {
    rqid: request.rqid,
    noCancel: request.noCancel,
    secondsLeft: request.secondsLeft,
    turnSecondsLeft: request.turnSecondsLeft,
    teamPreview: Boolean(request.teamPreview),
    forceSwitch: request.forceSwitch,
  };
}

function hpPercent(condition) {
  if (!condition || condition === '0 fnt' || condition.endsWith(' fnt')) return condition ? 0 : null;
  const [hpText, maxText] = String(condition).split(/[ /]/);
  const hp = Number(hpText);
  const max = Number(maxText);
  if (Number.isFinite(hp) && Number.isFinite(max) && max > 0) return (hp / max) * 100;
  return null;
}

function speciesFromDetails(details = '') {
  return String(details).split(',')[0].replace(/^p[12]a:\s*/i, '').trim();
}

function pokemonName(ident = '') {
  return String(ident).replace(/^p[12]a:\s*/i, '').trim();
}

function mechanicLabel(suffix) {
  if (suffix === 'mega') return 'Mega';
  if (suffix === 'megax') return 'Mega X';
  if (suffix === 'megay') return 'Mega Y';
  return suffix;
}

function isTimerLow(timer) {
  const secondsLeft = Number(timer?.secondsLeft ?? Infinity);
  const turnSecondsLeft = Number(timer?.turnSecondsLeft ?? Infinity);
  return Math.min(secondsLeft, turnSecondsLeft) <= 45;
}
