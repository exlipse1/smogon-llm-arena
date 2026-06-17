import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'node_modules', 'pokemon-showdown');
const builtEntry = path.join(packageRoot, 'dist', 'sim', 'index.js');
const buildScript = path.join(packageRoot, 'build');

if (!fs.existsSync(packageRoot)) {
  throw new Error('pokemon-showdown is not installed. Run pnpm install first.');
}

if (fs.existsSync(builtEntry)) {
  console.log('Pokemon Showdown is already built.');
  process.exit(0);
}

const result = spawnSync(process.execPath, [buildScript], {
  cwd: packageRoot,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
