const colorSet = ['#ef3e2d', '#007a78', '#6f4cc3', '#c08a00', '#1764ff', '#d5448b'];
const chartRatingFloor = 1000;
const state = {
  data: null,
  sortBy: 'rating',
};

document.getElementById('sortControl').addEventListener('change', event => {
  state.sortBy = event.target.value;
  render();
});

let chartResizeFrame = null;
window.addEventListener('resize', () => {
  if (!state.data || chartResizeFrame !== null) return;
  chartResizeFrame = window.requestAnimationFrame(() => {
    chartResizeFrame = null;
    drawChart([...state.data.players].sort(sortPlayers));
  });
});

loadDashboard();

async function loadDashboard() {
  state.data = await fetchJson('./leaderboard.json').catch(() => fetchJson('./leaderboard.sample.json'));
  render();
}

async function fetchJson(url) {
  const response = await fetch(`${url}?t=${Date.now()}`);
  if (!response.ok) throw new Error(`Could not load ${url}`);
  return response.json();
}

function render() {
  const data = state.data;
  if (!data) return;
  const players = [...data.players].sort(sortPlayers);
  document.getElementById('seasonName').textContent = data.season?.name ?? data.manifestName ?? 'Season';
  document.getElementById('formatName').textContent = data.formatName;
  document.getElementById('totalGames').textContent = `${data.totalGames} games`;
  document.getElementById('updatedAt').textContent = `Updated ${formatDate(data.generatedAt)}`;
  document.getElementById('ratingSystem').textContent = `${data.ratingSystem.name.toUpperCase()} K=${data.ratingSystem.kFactor}`;
  renderStatus(data, players);
  renderLeaderboard(players);
  renderHealth(players);
  drawChart(players);
}

function renderStatus(data, players) {
  const health = data.health ?? {};
  const grid = document.querySelector('.status-grid');
  const activePlayers = health.activePlayers ?? players.filter(player => player.games > 0).length;
  const state = health.state ?? 'unknown';
  const lastBattle = health.lastBattleAt ? formatDate(health.lastBattleAt) : 'none';
  grid.innerHTML = `
    <article class="status-card ${stateClass(state)}">
      <span>Runner</span>
      <strong>${titleCase(state)}</strong>
    </article>
    <article class="status-card">
      <span>Active Models</span>
      <strong>${activePlayers}/${players.length}</strong>
    </article>
    <article class="status-card">
      <span>Last Battle</span>
      <strong>${lastBattle}</strong>
    </article>
  `;
}

function renderLeaderboard(players) {
  const body = document.getElementById('leaderboardBody');
  body.innerHTML = players.map((player, index) => {
    const delta = Number.isFinite(Number(player.ratingDelta)) ? Number(player.ratingDelta) : null;
    const deltaMarkup = leaderboardDelta(delta);
    const modelLabel = [player.model ?? player.type, player.reasoningEffort ? `reasoning ${player.reasoningEffort}` : null]
      .filter(Boolean)
      .join(' / ');
    return `
      <tr>
        <td>${index + 1}</td>
        <td>
          <div class="model-cell">
            <span class="rank-mark" style="background: ${colorFor(index)}"></span>
            <span>
              <strong>${escapeHtml(player.name)}</strong>
              <span class="subtext">${escapeHtml(modelLabel)} · ${escapeHtml(player.teamSource ?? player.teamFile)}</span>
            </span>
          </div>
        </td>
        <td><span class="rating">${player.rating}</span> ${deltaMarkup}</td>
        <td>${recordCell(player)}</td>
        <td>${winRateCell(player)}</td>
        <td>${player.averageTurns}</td>
        <td>${player.invalidActions}</td>
        <td>${player.timeouts}</td>
      </tr>
    `;
  }).join('');
}

function renderHealth(players) {
  const grid = document.querySelector('.health-grid');
  grid.innerHTML = players.map((player, index) => `
    <article class="health-card" style="--accent: ${colorFor(index)}">
      <header>
        <div>
          <h3>${escapeHtml(player.name)}</h3>
          <p>${escapeHtml(player.model ?? player.type)}${player.reasoningEffort ? ` / reasoning ${escapeHtml(player.reasoningEffort)}` : ''}</p>
        </div>
        <span>${streakText(player.currentStreak)}</span>
      </header>
      <div class="metric-row">
        <div class="metric"><b>${player.peakRating}</b><span>Peak</span></div>
        <div class="metric"><b>${percent(player.actionFailureRate)}</b><span>Action failures</span></div>
      </div>
    </article>
  `).join('');
}

function recordCell(player) {
  return `${player.wins}-${player.losses}-${player.ties}`;
}

function winRateCell(player) {
  return percent(player.winRate);
}

function drawChart(players) {
  const canvas = document.getElementById('ratingChart');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const {width, height} = resizeCanvas(canvas, ctx);
  const padding = {top: 28, right: 34, bottom: 58, left: 82};
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, width, height);

  const histories = players.map(player => cleanRatingHistory(player));
  const points = histories.flat();
  if (!points.length) return;
  const maxBattle = Math.max(1, ...points.map(point => point.battle));
  const {minRating, maxRating} = chartRatingDomain(points);

  drawGrid(ctx, width, height, padding, minRating, maxRating, maxBattle);
  players.forEach((player, index) => {
    const history = histories[index] ?? [];
    if (!history.length) return;
    ctx.beginPath();
    history.forEach((point, pointIndex) => {
      const x = scale(point.battle, 0, maxBattle, padding.left, width - padding.right);
      const y = scale(point.rating, minRating, maxRating, height - padding.bottom, padding.top);
      if (pointIndex === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colorFor(index);
    ctx.lineWidth = 2.75;
    ctx.stroke();
    const last = history[history.length - 1];
    const lx = scale(last.battle, 0, maxBattle, padding.left, width - padding.right);
    const ly = scale(last.rating, minRating, maxRating, height - padding.bottom, padding.top);
    ctx.fillStyle = colorFor(index);
    ctx.beginPath();
    ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function resizeCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(360, Math.round(rect.width || canvas.clientWidth || canvas.width));
  const height = Math.max(300, Math.round(rect.height || canvas.clientHeight || canvas.height));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {width, height};
}

function drawGrid(ctx, width, height, padding, minRating, maxRating, maxBattle) {
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;

  ctx.strokeStyle = '#ccd5d8';
  ctx.fillStyle = '#4f5c61';
  ctx.lineWidth = 1;
  ctx.font = '13px ui-sans-serif, system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = scale(i, 0, 4, plotBottom, plotTop);
    const rating = Math.round(scale(i, 0, 4, minRating, maxRating));
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(String(rating), plotLeft - 14, y);
  }

  ctx.strokeStyle = '#16191b';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();

  ctx.fillStyle = '#4f5c61';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  battleAxisTicks(maxBattle).forEach(tick => {
    const x = scale(tick, 0, maxBattle, plotLeft, plotRight);
    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, plotBottom + 5);
    ctx.stroke();
    ctx.fillText(String(tick), x, plotBottom + 9);
  });
  ctx.fillText('Battle', (plotLeft + plotRight) / 2, height - 19);
}

function battleAxisTicks(maxBattle) {
  const ticks = new Set([0, maxBattle]);
  for (let i = 1; i < 4; i++) {
    ticks.add(Math.round((maxBattle * i) / 4));
  }
  return [...ticks]
    .filter(tick => Number.isFinite(tick) && tick >= 0)
    .sort((a, b) => a - b);
}

function cleanRatingHistory(player) {
  const history = (player.ratingHistory ?? [])
    .map(point => ({
      ...point,
      battle: Number(point.battle ?? 0),
      rating: Number(point.rating),
    }))
    .filter(point =>
      Number.isFinite(point.battle) &&
      Number.isFinite(point.rating) &&
      point.rating >= chartRatingFloor
    );
  if (history.length) return history;
  const rating = Number(player.rating);
  if (!Number.isFinite(rating) || rating < chartRatingFloor) return [];
  return [{battle: 0, rating: Math.round(rating), at: player.lastBattleAt ?? null}];
}

function chartRatingDomain(points) {
  const ratings = points.map(point => point.rating);
  const minObserved = Math.min(...ratings);
  const maxObserved = Math.max(...ratings);
  const minRating = Math.max(chartRatingFloor, Math.floor((minObserved - 20) / 25) * 25);
  let maxRating = Math.ceil((maxObserved + 20) / 25) * 25;
  if (maxRating <= minRating) maxRating = minRating + 50;
  return {minRating, maxRating};
}

function sortPlayers(a, b) {
  const key = state.sortBy;
  if (key === 'actionFailureRate') return a[key] - b[key] || b.rating - a.rating;
  return b[key] - a[key] || b.rating - a.rating;
}

function colorFor(index) {
  return colorSet[index % colorSet.length];
}

function percent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function leaderboardDelta(delta) {
  if (delta === null) return '<span class="delta-muted">-</span>';
  const deltaClass = delta >= 0 ? 'delta-up' : 'delta-down';
  return `<span class="${deltaClass}">${formatDelta(delta)}</span>`;
}

function formatDelta(value) {
  if (!value) return '0';
  return value > 0 ? `+${value}` : String(value);
}

function formatDate(value) {
  if (!value) return 'never';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function streakText(streak) {
  if (!streak?.count) return 'No streak';
  return `${streak.kind} ${streak.count}`;
}

function scale(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function titleCase(value) {
  return String(value ?? 'unknown')
    .split('-')
    .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function stateClass(state) {
  if (state === 'active') return 'status-ok';
  if (state === 'degraded') return 'status-warn';
  return 'status-waiting';
}
