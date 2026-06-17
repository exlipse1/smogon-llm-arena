import {loadShowdown} from './load.js';

export function importTeam(exportedTeam) {
  const {Teams} = loadShowdown();
  const team = Teams.import(exportedTeam);
  if (!team?.length) throw new Error('No Pokemon could be imported from team text.');
  return team;
}

export function packTeam(exportedTeam) {
  const {Teams} = loadShowdown();
  return Teams.pack(importTeam(exportedTeam));
}

export function exportTeam(team) {
  const {Teams} = loadShowdown();
  return Teams.export(Array.isArray(team) ? team : Teams.unpack(team));
}

export function validateTeam(formatName, exportedTeam) {
  const {TeamValidator} = loadShowdown();
  const team = importTeam(exportedTeam);
  const validator = TeamValidator.get(formatName);
  const problems = validator.validateTeam(team) ?? [];
  return {
    valid: problems.length === 0,
    problems,
    packed: loadShowdown().Teams.pack(team),
    pokemonCount: team.length,
  };
}
