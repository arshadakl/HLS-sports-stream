async function loadManifest() {
  const res = await fetch('https://raw.githubusercontent.com/drmlive/fancode-live-events/main/fancode.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('manifest fetch failed');
  return res.json();
}

function normalizeMatch(m) {
  const teams = m.teams || [m.team_1, m.team_2].filter(Boolean);
  const stream = m.stream || m.dai_url || m.adfree_url || null;
  return { ...m, teams, stream };
}

let allMatches = [];
let activeTab = 'live';

function renderCards(matches, grid) {
  grid.innerHTML = '';
  if (!matches || matches.length === 0) {
    grid.innerHTML = '<p class="col-span-full text-center text-sm text-muted-foreground py-12">No events in this category.</p>';
    return;
  }
  for (const raw of matches) {
    const m = normalizeMatch(raw);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.innerHTML = `
      <div class="relative w-full overflow-hidden">
        ${m.src
          ? `<img src="${m.src}" alt="" loading="lazy" class="block w-full aspect-video object-cover" />`
          : '<div class="block w-full aspect-video bg-muted"></div>'}
        <div class="absolute inset-x-0 top-0 flex items-start justify-between p-2 pointer-events-none">
          <div class="flex items-center gap-1.5">
            <span class="inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              <span class="h-1.5 w-1.5 rounded-full bg-white animate-pulse-dot"></span>
              ${m.status === 'LIVE' ? 'Live' : m.status}
            </span>
            ${m.event_category ? `<span class="rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-200 backdrop-blur-sm">${m.event_category}</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5">
            ${m.stream ? '<span class="rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-slate-100 backdrop-blur-sm">Stream 1</span>' : ''}
          </div>
        </div>
      </div>
      <div class="px-3 py-2.5">
        <p class="text-[13px] font-semibold leading-snug text-foreground line-clamp-2 mb-1">${m.title || m.match_name || ''}</p>
        <p class="text-xs text-muted-foreground mb-2">${m.teams.join(' vs ')}</p>
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-muted-foreground/70">${m.startTime || ''}</span>
          ${m.stream ? '<span class="text-xs font-semibold text-primary hover:underline">Watch</span>' : ''}
        </div>
      </div>`;
    card.addEventListener('click', () => openPlayer(m));
    grid.appendChild(card);
  }
}

function filterAndRender() {
  const grid = document.getElementById('matches-grid');
  const filtered = allMatches.filter((m) => {
    if (activeTab === 'live') return m.status === 'LIVE';
    return m.status !== 'LIVE';
  });
  renderCards(filtered, grid);
}

function openPlayer(match) {
  const modal = document.getElementById('player-modal');
  const video = document.getElementById('video');
  const title = document.getElementById('player-title');
  const message = document.getElementById('player-message');

  title.textContent = match.title || match.match_name || '';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('overflow-hidden');

  if (match.src) {
    video.poster = match.src;
  } else {
    video.removeAttribute('poster');
  }

  if (!match.stream) {
    message.classList.remove('hidden');
    return;
  }

  message.classList.add('hidden');
  playHls(video, match.stream);
}

function playHls(video, src) {
  if (window.__hls) { window.__hls.destroy(); window.__hls = null; }
  const proxySrc = '/api/proxy?url=' + encodeURIComponent(src);

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    window.__hls = hls;
    hls.loadSource(proxySrc);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        console.error('[HLS] Fatal error:', data.type, data.details);
        showPlayerMessage('Stream playback error: ' + data.details);
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxySrc;
    video.play().catch((e) => console.error('[HLS] Playback failed:', e));
  } else {
    showPlayerMessage('HLS is not supported in this browser.');
  }
}

function showPlayerMessage(msg) {
  const el = document.getElementById('player-message');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function init() {
  const grid = document.getElementById('matches-grid');
  const loader = document.getElementById('loader');
  try {
    const data = await loadManifest();
    allMatches = (data.matches || []).map(normalizeMatch);
    filterAndRender();
    grid.classList.remove('hidden');
    loader.classList.add('hidden');
  } catch (e) {
    loader.innerHTML = '<p class="text-sm text-destructive">Failed to load manifest.</p>';
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      updateTabStyles();
      filterAndRender();
    });
  });
  updateTabStyles();
}

function updateTabStyles() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const isActive = btn.dataset.tab === activeTab;
    if (isActive) {
      btn.classList.add('bg-background', 'text-foreground', 'shadow-sm');
      btn.classList.remove('text-muted-foreground');
    } else {
      btn.classList.remove('bg-background', 'text-foreground', 'shadow-sm');
      btn.classList.add('text-muted-foreground');
    }
  });
}

document.getElementById('close-player').addEventListener('click', () => {
  document.getElementById('player-modal').classList.add('hidden');
  document.getElementById('player-modal').classList.remove('flex');
  document.body.classList.remove('overflow-hidden');
  if (window.__hls) { window.__hls.destroy(); window.__hls = null; }
  const video = document.getElementById('video');
  video.pause();
  video.removeAttribute('src');
  video.removeAttribute('poster');
});

init();
