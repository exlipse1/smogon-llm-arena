import fs from 'node:fs/promises';
import path from 'node:path';
import {fromRoot} from './paths.js';

export async function readJson(relativePath) {
  const text = await fs.readFile(fromRoot(relativePath), 'utf8');
  return JSON.parse(text);
}

export async function readJsonIfExists(relativePath, fallback = null) {
  const absolute = path.isAbsolute(relativePath) ? relativePath : fromRoot(relativePath);
  try {
    const text = await fs.readFile(absolute, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function readJsonlIfExists(relativePath) {
  const absolute = path.isAbsolute(relativePath) ? relativePath : fromRoot(relativePath);
  try {
    const text = await fs.readFile(absolute, 'utf8');
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readTextMaybeRoot(filePath) {
  const absolute = path.isAbsolute(filePath) ? filePath : fromRoot(filePath);
  return fs.readFile(absolute, 'utf8');
}

export async function writeJson(relativePath, value) {
  const absolute = path.isAbsolute(relativePath) ? relativePath : fromRoot(relativePath);
  await fs.mkdir(path.dirname(absolute), {recursive: true});
  const tmp = `${absolute}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, absolute);
}

export async function writeText(relativePath, value) {
  const absolute = path.isAbsolute(relativePath) ? relativePath : fromRoot(relativePath);
  await fs.mkdir(path.dirname(absolute), {recursive: true});
  await fs.writeFile(absolute, value);
}

export async function appendJsonl(relativePath, value) {
  const absolute = path.isAbsolute(relativePath) ? relativePath : fromRoot(relativePath);
  await fs.mkdir(path.dirname(absolute), {recursive: true});
  await fs.appendFile(absolute, `${JSON.stringify(value)}\n`);
}
