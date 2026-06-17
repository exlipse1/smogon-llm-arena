const DATA_URL = './leaderboard.json';
const REFRESH_MS = 30_000;
const LIVE_STATUS_MAX_AGE_MS = 3 * 60 * 1000;
const SHOWDOWN_BATTLE_BASE_URL = 'https://play.pokemonshowdown.com/';

const state = {
  data: null,
  sortKey: 'rating',
};

const playerColors = {
  'gpt-5.5': '#f05a28',
  'gpt-5.5-high': '#2f6fed',
  'gpt-5.2': '#007f73',
  'gpt-5.4': '#7357c8',
  o3: '#d19b1d',
};

const fallbackColors = ['#f05a28', '#007f73', '#7357c8', '#d19b1d', '#2f6fed', '#d5448b'];

const sortControl = document.getElementById('sortControl');
sortControl?.addEventListener('change', event => {
  state.sortKey = event.target.value;
  render();
});

let chartResizeFrame = null;
window.addEventListener('resize', () => {
  if (!state.data || chartResizeFrame !== null) return;
  chartResizeFrame = window.requestAnimationFrame(() => {
    chartResizeFrame = null;
    drawChart(sortPlayers(state.data.players ?? []));
  });
});

async function load() {
  try {
    state.data = await fetchJson(DATA_URL).catch(() => fetchJson('./leaderboard.sample.json'));
    render();
  } catch (error) {
    document.querySelector('.scoreline').innerHTML = `<p class="empty-state">Could not load leaderboard data: ${escapeHtml(error.message)}</p>`;
  }
}

setInterval(load, REFRESH_MS);

async function fetchJson(url) {
  const response = await fetch(`${url}?t=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function render() {
  const data = state.data;
  if (!data) return;

  const players = sortPlayers(data.players ?? []);

  document.getElementById('formatName').textContent = data.formatName ?? data.format ?? data.formatId ?? 'Unknown';
  document.getElementById('totalGames').textContent = String(data.totalGames ?? 0);
  const updatedAt = document.getElementById('updatedAt');
  if (updatedAt) updatedAt.textContent = `Updated ${formatDate(data.generatedAt)}`;
  document.getElementById('lastBattle').textContent = formatDate(data.health?.lastBattleAt ?? data.generatedAt);

  renderScoreline(players);
  renderLiveMatches(players);
  renderLeaderboard(players);
  renderChartLegend(players);
  drawChart(players);
}

function sortPlayers(players) {
  return [...players].sort((a, b) => {
    if (state.sortKey === 'actionFailureRate') {
      return Number(a.actionFailureRate ?? 0) - Number(b.actionFailureRate ?? 0) || Number(b.rating ?? 0) - Number(a.rating ?? 0);
    }
    return Number(b[state.sortKey] ?? 0) - Number(a[state.sortKey] ?? 0) || Number(b.rating ?? 0) - Number(a.rating ?? 0);
  });
}

function renderScoreline(players) {
  const scoreline = document.querySelector('.scoreline');
  if (!players.length) {
    scoreline.innerHTML = '<p class="empty-state">No matches recorded yet.</p>';
    return;
  }

  scoreline.innerHTML = players.map((player, index) => {
    const accent = colorForPlayer(player, index);
    return `
      <article class="score-card" style="--accent:${accent}">
        <div class="score-rank">#${index + 1}</div>
        <h3>${escapeHtml(displayName(player))}</h3>
        <div class="score-rating">${ratingCell(player.rating)}</div>
        <div class="score-meta">
          <span>${recordCell(player)}</span>
          <span>${winRateCell(player)}</span>
          <span>${escapeHtml(streakText(player.currentStreak))}</span>
        </div>
      </article>
    `;
  }).join('');
}

function renderLeaderboard(players) {
  const tbody = document.getElementById('leaderboardBody');
  if (!players.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No matches recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = players.map((player, index) => {
    const delta = Number(player.ratingDelta ?? 0);
    const accent = colorForPlayer(player, index);
    return `
      <tr>
        <td class="rank-cell">${String(index + 1).padStart(2, '0')}</td>
        <td>
          <div class="model-cell">
            <span class="rank-mark" style="background:${accent}"></span>
            <span>
              <strong>${escapeHtml(displayName(player))}</strong>
              <span class="subtext">${escapeHtml(modelLine(player))}</span>
            </span>
          </div>
        </td>
        <td><span class="rating">${ratingCell(player.rating)}</span></td>
        <td>${deltaCell(delta)}</td>
        <td>${recordCell(player)}</td>
        <td>${winRateCell(player)}</td>
        <td>${watchCell(player)}</td>
        <td>${formatNumber(player.averageTurns)}</td>
        <td>${formatNumber(totalMisses(player))}</td>
      </tr>
    `;
  }).join('');
}

function renderLiveMatches(players) {
  const section = document.querySelector('.live-section');
  const list = document.getElementById('liveMatches');
  const active = players
    .map(player => ({player, battle: activeBattle(player)}))
    .filter(entry => entry.battle);

  section.hidden = active.length === 0;
  if (!active.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = active.map(({player, battle}, index) => `
    <a class="live-match" style="--accent:${colorForPlayer(player, index)}" href="${battle.url}" target="_blank" rel="noopener noreferrer">
      <span>
        <strong>${escapeHtml(displayName(player))}</strong>
        <small>${escapeHtml(liveMatchLine(player))}</small>
      </span>
      <b>Watch</b>
    </a>
  `).join('');
}

function renderChartLegend(players) {
  const legend = document.getElementById('chartLegend');
  legend.innerHTML = players.map((player, index) => `
    <span>
      <i style="background:${colorForPlayer(player, index)}"></i>
      ${escapeHtml(displayName(player))}
    </span>
  `).join('');
}

function drawChart(players) {
  const canvas = document.getElementById('ratingChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const margin = { top: 34, right: 28, bottom: 54, left: 74 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);

  const histories = players.map(player => ({
    player,
    points: cleanRatingHistory(player.ratingHistory),
  })).filter(entry => entry.points.length);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101314';
  ctx.fillRect(0, 0, width, height);

  if (!histories.length) {
    ctx.fillStyle = '#f3f6f1';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('No rating history yet.', margin.left, margin.top + 28);
    return;
  }

  const allRatings = histories.flatMap(entry => entry.points.map(point => point.rating));
  const { minRating, maxRating } = chartRatingDomain(allRatings);
  const maxBattle = Math.max(1, ...histories.flatMap(entry => entry.points.map(point => point.plotBattle)));
  const xTicks = buildBattleTicks(maxBattle);
  const yTicks = buildRatingTicks(minRating, maxRating);

  const xFor = point => margin.left + (point.plotBattle / maxBattle) * plotWidth;
  const yFor = rating => margin.top + (1 - (rating - minRating) / (maxRating - minRating)) * plotHeight;

  drawGrid(ctx, { margin, plotWidth, plotHeight, width, height, xTicks, yTicks, xForValue: value => margin.left + (value / maxBattle) * plotWidth, yFor });

  histories.forEach((entry, index) => {
    const color = colorForPlayer(entry.player, index);
    const points = entry.points;

    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;

    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1];
      const current = points[i];
      ctx.setLineDash(current.source === 'estimated-final' ? [7, 6] : []);
      ctx.beginPath();
      ctx.moveTo(xFor(previous), yFor(previous.rating));
      ctx.lineTo(xFor(current), yFor(current.rating));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    points.forEach((point, pointIndex) => {
      const isLast = pointIndex === points.length - 1;
      const radius = isLast ? 5 : 2.6;
      ctx.beginPath();
      ctx.arc(xFor(point), yFor(point.rating), radius, 0, Math.PI * 2);
      ctx.fillStyle = point.source === 'estimated-final' ? '#101314' : color;
      ctx.fill();
      ctx.lineWidth = point.source === 'estimated-final' ? 2.4 : 1.2;
      ctx.strokeStyle = color;
      ctx.stroke();
    });
  });
}

function drawGrid(ctx, details) {
  const { margin, plotWidth, plotHeight, width, height, xTicks, yTicks, xForValue, yFor } = details;

  ctx.save();
  ctx.strokeStyle = 'rgba(243, 246, 241, 0.13)';
  ctx.lineWidth = 1;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(243, 246, 241, 0.72)';
  ctx.textBaseline = 'middle';

  yTicks.forEach(tick => {
    const y = yFor(tick);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(width - margin.right, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(String(tick), margin.left - 14, y);
  });

  ctx.strokeStyle = 'rgba(243, 246, 241, 0.26)';
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, height - margin.bottom);
  ctx.lineTo(width - margin.right, height - margin.bottom);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(243, 246, 241, 0.1)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  xTicks.forEach(tick => {
    const x = xForValue(tick);
    ctx.beginPath();
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, margin.top + plotHeight);
    ctx.stroke();
    ctx.fillText(String(tick), x, height - margin.bottom + 18);
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(243, 246, 241, 0.78)';
  ctx.fillText('Battle', margin.left, height - 14);

  ctx.restore();
}

function cleanRatingHistory(history = []) {
  return history
    .map(point => {
      const battle = Number(point.battle ?? 0);
      const rating = Number(point.rating);
      const offset = point.source === 'estimated-final' ? 0.65 : 0;
      return {
        battle,
        plotBattle: battle + offset,
        rating,
        source: point.source,
      };
    })
    .filter(point => Number.isFinite(point.battle) && Number.isFinite(point.rating))
    .sort((a, b) => a.plotBattle - b.plotBattle);
}

function chartRatingDomain(ratings) {
  const minRaw = Math.min(...ratings, 1000);
  const maxRaw = Math.max(...ratings, 1000);
  const padding = Math.max(16, Math.ceil((maxRaw - minRaw) * 0.16));
  const minRating = Math.max(1000, Math.floor((minRaw - padding) / 10) * 10);
  const maxRating = Math.ceil((maxRaw + padding) / 10) * 10;
  if (minRating === maxRating) {
    return { minRating: minRating - 20, maxRating: maxRating + 20 };
  }
  return { minRating, maxRating };
}

function buildRatingTicks(minRating, maxRating) {
  const range = maxRating - minRating;
  const step = range > 160 ? 50 : range > 80 ? 25 : 10;
  const ticks = [];
  const start = Math.ceil(minRating / step) * step;
  for (let value = start; value <= maxRating; value += step) {
    ticks.push(value);
  }
  return ticks.length ? ticks : [minRating, maxRating];
}

function buildBattleTicks(maxBattle) {
  const step = maxBattle > 80 ? 20 : maxBattle > 40 ? 10 : maxBattle > 16 ? 5 : 2;
  const ticks = [0];
  for (let value = step; value <= maxBattle; value += step) {
    ticks.push(value);
  }
  const roundedMax = Math.ceil(maxBattle);
  if (!ticks.includes(roundedMax)) ticks.push(roundedMax);
  return ticks;
}

function colorForPlayer(player, index) {
  return playerColors[player.id] ?? fallbackColors[index % fallbackColors.length];
}

function activeBattle(player) {
  const status = player.liveStatus ?? {};
  const roomId = String(status.battleRoomId ?? '');
  if (!/^battle-[a-z0-9-]+$/i.test(roomId)) return null;
  const state = String(status.state ?? '').toLowerCase();
  const inactiveStates = new Set(['unknown', 'searching', 'battle-ended', 'ended', 'error', 'idle']);
  if (inactiveStates.has(state)) return null;
  const updatedAt = Date.parse(status.updatedAt ?? '');
  if (!Number.isFinite(updatedAt)) return null;
  if (Math.max(0, Date.now() - updatedAt) > LIVE_STATUS_MAX_AGE_MS) return null;
  return {
    roomId,
    url: `${SHOWDOWN_BATTLE_BASE_URL}${roomId}`,
  };
}

function liveMatchLine(player) {
  const status = player.liveStatus ?? {};
  const opponent = status.opponent?.username ? `vs ${status.opponent.username}` : status.label ?? status.state ?? 'live';
  const turn = Number(status.battleTurns ?? 0);
  return turn > 0 ? `${opponent} / turn ${turn}` : opponent;
}

function watchCell(player) {
  const battle = activeBattle(player);
  if (!battle) return '<span class="watch-muted">-</span>';
  return `<a class="watch-link" href="${battle.url}" target="_blank" rel="noopener noreferrer">Watch</a>`;
}

function displayName(player) {
  const id = String(player.id ?? '');
  if (id === 'gpt-5.5-high') return '5.5 high';
  if (id.startsWith('gpt-')) return id.replace('gpt-', '');
  if (id === 'o3') return 'o3';
  return String(player.model ?? player.name ?? (id || 'model'))
    .replace(/^OpenAI\s+GPT-/i, '')
    .replace(/^OpenAI\s+/i, '')
    .replace(/^GPT-/i, '');
}

function modelLine(player) {
  const effort = player.reasoningEffort ? `${player.reasoningEffort} reasoning` : 'reasoning recorded';
  const games = Number(player.games ?? 0);
  return `${effort} / ${games} games`;
}

function recordCell(player) {
  return `${formatNumber(player.wins)}-${formatNumber(player.losses)}`;
}

function winRateCell(player) {
  return `${formatPercent(player.winRate)}%`;
}

function ratingCell(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : '0';
}

function deltaCell(delta) {
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const sign = delta > 0 ? '+' : '';
  return `<span class="delta-pill ${direction}">${sign}${Math.round(delta)}</span>`;
}

function streakText(streak) {
  const count = Number(streak?.count ?? 0);
  if (!count) return 'even';
  const kind = String(streak?.kind ?? streak?.type ?? '').toLowerCase();
  if (kind.startsWith('tie')) return 'even';
  const label = kind.startsWith('win') ? 'W' : kind.startsWith('loss') ? 'L' : kind.slice(0, 1).toUpperCase();
  return `${label}${count}`;
}

function totalMisses(player) {
  return Number(player.invalidActions ?? 0) + Number(player.timeouts ?? 0) + Number(player.errors ?? 0);
}

function formatNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString() : '0';
}

function formatPercent(value) {
  const number = Number(value ?? 0) * 100;
  return Number.isFinite(number) ? number.toFixed(1) : '0.0';
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

load();
