const DEFAULT_USERS_BASE_URL = 'https://pokemonshowdown.com/users';

export async function fetchPublicUserRating({
  username,
  formatId,
  usersBaseUrl = DEFAULT_USERS_BASE_URL,
  timeoutMs = 10_000,
} = {}) {
  if (!username) return null;
  if (!formatId) throw new Error('fetchPublicUserRating requires a formatId.');

  const userid = toId(username);
  const url = `${usersBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(userid)}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {signal: controller.signal});
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Pokemon Showdown user rating request failed with HTTP ${response.status}.`);
    }
    const data = await response.json();
    const rating = data.ratings?.[formatId] ?? null;
    return {
      source: 'pokemon-showdown-users-json',
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      username: data.username ?? username,
      userid: data.userid ?? userid,
      registerTime: numberOrNull(data.registertime),
      formatId,
      found: Boolean(rating),
      elo: numberOrNull(rating?.elo),
      gxe: numberOrNull(rating?.gxe),
      glicko: numberOrNull(rating?.rpr),
      glickoDeviation: numberOrNull(rating?.rprd),
      wins: numberOrNull(rating?.w),
      losses: numberOrNull(rating?.l),
      coil: numberOrNull(rating?.coil),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function toId(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
