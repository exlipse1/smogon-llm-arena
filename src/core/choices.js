export function legalChoicesFromRequest(request) {
  if (!request || request.wait) return [];

  if (request.forceSwitch?.some(Boolean)) {
    return legalSwitchChoices(request);
  }

  if (request.teamPreview) {
    const slots = request.side?.pokemon?.map((_, index) => String(index + 1)).join('') ?? '123456';
    return [`team ${slots}`];
  }

  const active = request.active?.[0];
  if (!active) return ['default'];

  const choices = [];
  for (const [index, move] of (active.moves ?? []).entries()) {
    if (!isUsableMove(move)) continue;
    const baseChoice = `move ${index + 1}`;
    choices.push(baseChoice);
    choices.push(...specialMoveChoices(active, move, index, baseChoice));
  }

  choices.push(...legalSwitchChoices(request));
  return choices.length ? choices : ['default'];
}

export function legalSwitchChoices(request) {
  const activeCount = request.side?.pokemon?.filter(pokemon => pokemon.active).length ?? 1;
  const switches = [];
  for (const [index, pokemon] of (request.side?.pokemon ?? []).entries()) {
    if (pokemon.active) continue;
    if (isFainted(pokemon.condition)) continue;
    switches.push(`switch ${index + 1}`);
  }
  return activeCount === 1 ? switches : switches.slice(0, 1);
}

export function isLegalChoice(request, choice) {
  const normalized = normalizeChoice(choice);
  if (!normalized) return false;
  if (request.teamPreview) return isLegalTeamPreviewChoice(request, normalized);
  return legalChoicesFromRequest(request).map(normalizeChoice).includes(normalized);
}

export function normalizeChoice(choice) {
  return String(choice ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function sanitizeRequestForPrompt(request) {
  if (!request) return null;
  return {
    rqid: request.rqid,
    noCancel: request.noCancel,
    secondsLeft: numberOrUndefined(request.secondsLeft),
    turnSecondsLeft: numberOrUndefined(request.turnSecondsLeft),
    teamPreview: Boolean(request.teamPreview),
    forceSwitch: request.forceSwitch,
    active: request.active?.map(active => ({
      moves: active.moves?.map(move => ({
        move: move.move,
        id: move.id,
        pp: move.pp,
        maxpp: move.maxpp,
        disabled: Boolean(move.disabled),
        target: move.target,
      })),
      canMegaEvo: Boolean(active.canMegaEvo),
      canMegaEvoX: Boolean(active.canMegaEvoX),
      canMegaEvoY: Boolean(active.canMegaEvoY),
      maybeTrapped: active.maybeTrapped,
      trapped: active.trapped,
    })),
    side: {
      name: request.side?.name,
      id: request.side?.id,
      pokemon: request.side?.pokemon?.map((pokemon, index) => ({
        slot: index + 1,
        ident: pokemon.ident,
        details: pokemon.details,
        condition: pokemon.condition,
        active: Boolean(pokemon.active),
        stats: pokemon.stats,
        moves: pokemon.moves,
        baseAbility: pokemon.baseAbility,
        ability: pokemon.ability,
        item: pokemon.item,
      })),
    },
  };
}

function specialMoveChoices(active, move, index, baseChoice) {
  const choices = [];
  if (active.canMegaEvo) choices.push(`${baseChoice} mega`);
  if (active.canMegaEvoX) choices.push(`${baseChoice} megax`);
  if (active.canMegaEvoY) choices.push(`${baseChoice} megay`);
  return choices;
}

function isUsableMove(move) {
  if (!move || move.disabled) return false;
  return move.pp !== 0 || move.id === 'struggle';
}

function numberOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : undefined;
}

function isFainted(condition = '') {
  return condition === '0 fnt' || condition.endsWith(' fnt');
}

function isLegalTeamPreviewChoice(request, choice) {
  if (choice === 'default') return true;
  const match = choice.match(/^team\s+([0-9,\s]+)$/);
  if (!match) return false;
  const slots = match[1].replace(/[,\s]/g, '').split('').map(Number);
  const teamSize = request.side?.pokemon?.length ?? 6;
  if (slots.length !== teamSize) return false;
  const expected = new Set(Array.from({length: teamSize}, (_, index) => index + 1));
  for (const slot of slots) {
    if (!expected.delete(slot)) return false;
  }
  return expected.size === 0;
}
