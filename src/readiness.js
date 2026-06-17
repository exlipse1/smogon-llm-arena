import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson, readJsonIfExists, readJsonlIfExists, readTextMaybeRoot} from './core/fs.js';
import {fromRoot} from './core/paths.js';
import {activePlayers} from './core/manifest.js';
import {checkFreeze, loadFreeze} from './showdown/freeze.js';
import {validateTeam} from './showdown/teams.js';
import {fetchPublicUserRating} from './showdown/public-ratings.js';

export async function auditBenchmarkReadiness(options = {}) {
  const {
    manifestPath = 'config/ladder.openai.example.json',
    matchesDir = 'results/live-ladder',
    sitePath = 'site/leaderboard.json',
    pollRatings = false,
    usersBaseUrl,
    externalUrl = null,
  } = options;

  const freezeCheck = await checkFreeze();
  const freeze = await loadFreeze();
  const manifest = await readJson(manifestPath);
  const generatedAt = new Date().toISOString();
  const sitePayload = await readJsonIfExists(sitePath, null);
  const players = [];

  const playersInScope = activePlayers(manifest);

  for (const player of playersInScope) {
    players.push(await auditPlayer({
      player,
      freeze,
      matchesDir,
      pollRatings,
      usersBaseUrl,
    }));
  }

  const externalSite = externalUrl ? await checkExternalSite(externalUrl) : null;
  const checks = [
    check('freeze', freezeCheck.ok, freezeCheck.problems),
    check('manifestPlayers', players.length >= 2, players.length ? [] : ['Manifest must contain at least two players.']),
    check('teams', players.every(player => player.team.valid), teamProblems(players)),
    check('teamPolicy', teamPolicySatisfied(manifest, players), teamPolicyProblems(manifest, players)),
    check('modelApiKeys', players.every(player => player.modelApi.ready), modelApiProblems(players)),
    check('credentials', players.every(player => player.account.hasUsername && player.account.hasPassword), credentialProblems(players)),
    check('logs', players.some(player => player.liveLog.records > 0), ['No live battle logs found yet.']),
    check('sitePayload', Boolean(sitePayload), [`Missing ${sitePath}. Run publish-live.`]),
  ];

  if (pollRatings) {
    checks.push(check(
      'publicRatings',
      players.every(player => !player.account.username || player.publicRating?.ok),
      publicRatingProblems(players)
    ));
  }
  if (externalSite) {
    checks.push(check('externalSite', externalSite.ok, externalSite.ok ? [] : [externalSite.error]));
  }

  const ready = checks.every(item => item.ok);
  return {
    ok: ready,
    generatedAt,
    manifestPath,
    matchesDir,
    sitePath,
    externalUrl,
    season: readinessSeason({manifest, freeze, generatedAt}),
    formatName: freeze.formatName,
    formatId: freeze.formatId,
    showdownCommit: freeze.showdownCommit,
    track: manifest.track ?? null,
    teamPolicy: manifest.teamPolicy ?? null,
    disabledPlayers: (manifest.players ?? [])
      .filter(player => player.enabled === false)
      .map(player => ({
        id: player.id,
        model: player.model ?? null,
        reason: player.disabledReason ?? null,
      })),
    checks,
    players,
    sitePayload: sitePayload ? {
      mode: sitePayload.mode,
      generatedAt: sitePayload.generatedAt,
      totalGames: sitePayload.totalGames,
      players: sitePayload.players?.length ?? 0,
    } : null,
    externalSite,
  };
}

async function auditPlayer({player, freeze, matchesDir, pollRatings, usersBaseUrl}) {
  const account = player.showdownAccount ?? player.account ?? {};
  const username = account.username ?? (account.usernameEnv ? process.env[account.usernameEnv] : null);
  const password = account.password ?? (account.passwordEnv ? process.env[account.passwordEnv] : null);
  const modelApi = auditModelApi(player);
  const team = await auditTeam(player, freeze);
  const liveLog = await auditLiveLog(player, matchesDir);
  const resolvedUsername = username ?? liveLog.lastAccountUsername ?? null;
  const publicRating = pollRatings && resolvedUsername ?
    await auditPublicRating({username: resolvedUsername, formatId: freeze.formatId, usersBaseUrl}) :
    null;

  return {
    id: player.id,
    name: player.name ?? player.id,
    model: player.model ?? null,
    type: player.type ?? 'openai',
    teamSource: player.teamSource ?? null,
    team,
    account: {
      username: resolvedUsername,
      usernameEnv: account.usernameEnv ?? null,
      passwordEnv: account.passwordEnv ?? null,
      hasUsername: Boolean(username),
      hasPassword: Boolean(password),
    },
    modelApi,
    liveLog,
    publicRating,
    ready: team.valid && modelApi.ready && Boolean(username && password),
  };
}

function auditModelApi(player) {
  const isOpenAi = (player.type ?? 'openai') === 'openai';
  const apiKeyEnv = player.apiKeyEnv ?? player.openaiApiKeyEnv ?? 'OPENAI_API_KEY';
  if (!isOpenAi) {
    return {
      provider: player.type ?? 'unknown',
      apiKeyEnv: null,
      hasApiKey: true,
      ready: true,
    };
  }
  return {
    provider: 'openai',
    apiKeyEnv,
    organizationEnv: player.organizationEnv ?? player.openaiOrganizationEnv ?? 'OPENAI_ORG_ID',
    projectEnv: player.projectEnv ?? player.openaiProjectEnv ?? 'OPENAI_PROJECT_ID',
    hasOrganization: Boolean(process.env[player.organizationEnv ?? player.openaiOrganizationEnv ?? 'OPENAI_ORG_ID'] ?? process.env.OPENAI_ORGANIZATION),
    hasProject: Boolean(process.env[player.projectEnv ?? player.openaiProjectEnv ?? 'OPENAI_PROJECT_ID'] ?? process.env.OPENAI_PROJECT),
    hasApiKey: Boolean(process.env[apiKeyEnv]),
    ready: Boolean(process.env[apiKeyEnv]),
  };
}

async function auditTeam(player, freeze) {
  const absolute = path.isAbsolute(player.teamFile) ? player.teamFile : fromRoot(player.teamFile);
  const exists = await existsFile(absolute);
  if (!exists) {
    return {
      file: player.teamFile,
      exists: false,
      valid: false,
      pokemonCount: 0,
      problems: [`Missing team file: ${player.teamFile}`],
    };
  }
  const teamText = await readTextMaybeRoot(player.teamFile);
  const validation = validateTeam(freeze.formatName, teamText);
  return {
    file: player.teamFile,
    exists: true,
    valid: validation.valid,
    pokemonCount: validation.pokemonCount,
    problems: validation.problems,
  };
}

async function auditLiveLog(player, matchesDir) {
  const logPath = `${matchesDir}/${player.id}.jsonl`;
  const records = await readJsonlIfExists(logPath);
  const ownRecords = records.filter(record => record.playerId === player.id);
  const latest = ownRecords.at(-1) ?? null;
  return {
    path: logPath,
    records: ownRecords.length,
    lastBattleAt: latest?.finishedAt ?? null,
    lastResult: latest?.result ?? null,
    lastAccountUsername: latest?.accountUsername ?? null,
  };
}

async function auditPublicRating({username, formatId, usersBaseUrl}) {
  try {
    const rating = await fetchPublicUserRating({username, formatId, usersBaseUrl});
    return {
      ok: Boolean(rating?.found),
      username,
      fetchedAt: rating?.fetchedAt ?? null,
      elo: rating?.elo ?? null,
      gxe: rating?.gxe ?? null,
      glicko: rating?.glicko ?? null,
      wins: rating?.wins ?? null,
      losses: rating?.losses ?? null,
      error: rating?.found ? null : `No ${formatId} public ladder rating found for ${username}.`,
    };
  } catch (error) {
    return {
      ok: false,
      username,
      error: String(error?.message ?? error),
    };
  }
}

async function checkExternalSite(externalUrl) {
  try {
    const url = new URL('leaderboard.json', externalUrl.endsWith('/') ? externalUrl : `${externalUrl}/`);
    const response = await fetch(url);
    if (!response.ok) {
      return {ok: false, url: String(url), error: `External leaderboard returned HTTP ${response.status}.`};
    }
    const data = await response.json();
    return {
      ok: true,
      url: String(url),
      generatedAt: data.generatedAt,
      totalGames: data.totalGames,
      players: data.players?.length ?? 0,
    };
  } catch (error) {
    return {ok: false, url: externalUrl, error: String(error?.message ?? error)};
  }
}

async function existsFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function check(name, ok, problems) {
  return {name, ok: Boolean(ok), problems: ok ? [] : problems};
}

function teamProblems(players) {
  return players.flatMap(player => player.team.valid ? [] :
    player.team.problems.map(problem => `${player.id}: ${problem}`));
}

function teamPolicySatisfied(manifest, players) {
  if (manifest.teamPolicy !== 'model-built-teams') return true;
  return players.every(player => player.teamSource === 'openai-generated');
}

function teamPolicyProblems(manifest, players) {
  if (manifest.teamPolicy !== 'model-built-teams') return [];
  return players
    .filter(player => player.teamSource !== 'openai-generated')
    .map(player => `${player.id}: team is ${player.teamSource ?? 'unmarked'}; run scripts/build-openai-roster-teams.mjs --force after OpenAI quota is available.`);
}

function credentialProblems(players) {
  return players.flatMap(player => {
    const problems = [];
    if (!player.account.hasUsername) problems.push(`${player.id}: missing ${player.account.usernameEnv ?? 'username'}`);
    if (!player.account.hasPassword) problems.push(`${player.id}: missing ${player.account.passwordEnv ?? 'password'}`);
    return problems;
  });
}

function modelApiProblems(players) {
  const missing = new Map();
  for (const player of players) {
    if (player.modelApi.ready) continue;
    const key = player.modelApi.apiKeyEnv ?? 'model API key';
    const ids = missing.get(key) ?? [];
    ids.push(player.id);
    missing.set(key, ids);
  }
  return [...missing.entries()].map(([key, ids]) => `${ids.join(', ')}: missing ${key}`);
}

function publicRatingProblems(players) {
  return players.flatMap(player => {
    if (!player.account.username || player.publicRating?.ok) return [];
    return [`${player.id}: ${player.publicRating?.error ?? 'public rating unavailable'}`];
  });
}

function readinessSeason({manifest, freeze, generatedAt}) {
  const configured = manifest.season ?? {};
  const id = configured.id ?? `${manifest.name ?? 'benchmark'}-${manifest.track ?? 'pilot'}-${freeze.freezeDate}`;
  return {
    id,
    name: configured.name ?? titleFromId(id),
    startedAt: configured.startedAt ?? isoStartOfDay(freeze.freezeDate) ?? generatedAt,
    generatedAt,
    description: configured.description ?? null,
    resetPolicy: configured.resetPolicy ?? null,
    archiveDir: configured.archiveDir ?? null,
  };
}

function isoStartOfDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return null;
  return `${date}T00:00:00.000Z`;
}

function titleFromId(id) {
  return String(id)
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
