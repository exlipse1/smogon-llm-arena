import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

let showdown;

export function loadShowdown() {
  if (!showdown) {
    showdown = require('pokemon-showdown');
  }
  return showdown;
}
