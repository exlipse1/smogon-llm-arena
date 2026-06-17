import {readJson} from '../core/fs.js';
import {loadShowdown} from './load.js';

export async function loadFreeze() {
  return readJson('config/freeze.json');
}

export async function checkFreeze() {
  const freeze = await loadFreeze();
  const {Dex} = loadShowdown();
  const format = Dex.formats.get(freeze.formatName);
  const problems = [];

  if (!format.exists) problems.push(`Format does not exist: ${freeze.formatName}`);
  if (format.id !== freeze.formatId) {
    problems.push(`Format id mismatch: expected ${freeze.formatId}, got ${format.id}`);
  }
  if (format.name !== freeze.formatName) {
    problems.push(`Format name mismatch: expected ${freeze.formatName}, got ${format.name}`);
  }
  if (format.mod !== 'champions') {
    problems.push(`Format mod mismatch: expected champions, got ${format.mod}`);
  }
  compareStringArray('ruleset', freeze.ruleset, format.ruleset ?? [], problems);
  compareStringArray('banlist', freeze.banlist, format.banlist ?? [], problems);

  for (const alias of freeze.formatAliases) {
    const aliased = Dex.formats.get(alias);
    if (aliased.id !== freeze.formatId) {
      problems.push(`Alias ${alias} resolves to ${aliased.id}, expected ${freeze.formatId}`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    freeze,
    observed: {
      id: format.id,
      name: format.name,
      mod: format.mod,
      ruleset: format.ruleset,
      banlist: format.banlist,
    },
  };
}

function compareStringArray(label, expected, actual, problems) {
  const left = JSON.stringify(expected);
  const right = JSON.stringify(actual);
  if (left !== right) {
    problems.push(`${label} mismatch: expected ${left}, got ${right}`);
  }
}
