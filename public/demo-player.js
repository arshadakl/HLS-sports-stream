const FANCODE_URL = 'https://raw.githubusercontent.com/drmlive/fancode-live-events/main/fancode.json';
const SONYLIV_URL = 'https://raw.githubusercontent.com/drmlive/sliv-live-events/main/sonyliv.json';
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.matches) ? data.matches : [];
  } catch {
    return [];
  }
}

function parseFancodeTime(str) {
  if (!str) return 0;
  const match = str.match(/(\d{2}):(\d{2}):(\d{2})\s(AM|PM)\s(\d{2})-(\d{2})-(\d{4})/i);
  if (!match) return 0;
  let [, hh, mm, ss, ampm, DD, MM, YYYY] = match;
  hh = parseInt(hh, 10);
  if (ampm.toUpperCase() === 'PM' && hh < 12) hh += 12;
  if (ampm.toUpperCase() === 'AM' && hh === 12) hh = 0;
  return new Date(`${YYYY}-${MM}-${DD}T${String(hh).padStart(2, '0')}:${mm}:${ss}+05:30`).getTime();
}

function buildStreamUrl(m, ua) {
  // Prefer hex-decoded akamai playlist (more stable than dai_url)
  if (m.akamai_m3u8_hex) {
    const params = new URLSearchParams({ hex: m.akamai_m3u8_hex });
    if (ua) params.set('ua', ua);
    return '/api/proxy?' + params.toString();
  }
  if (m.dai_url || m.adfree_url) {
    const params = new URLSearchParams({ url: m.dai_url || m.adfree_url });
    if (ua) params.set('ua', ua);
    return '/api/proxy?' + params.toString();
  }
  return null;
}

function normalizeFancode(m) {
  const ua = m['user-agent'] || DEFAULT_UA;
  return {
    id: 'fancode:' + m.match_id,
    provider: 'Fancode',
    isLive: m.status === 'LIVE',
    status: m.status,
    title: m.match_name || m.title || 'Fancode Event',
    competition: m.event_name || m.event_category || 'Unknown',
    team1: m.team_1,
    team2: m.team_2,
    category: m.event_category,
    channel: null,
    language: m.audioLanguageName || null,
    poster: m.src,
    startTime: m.startTime || null,
    startTimeMs: parseFancodeTime(m.startTime),
    streamUrl: buildStreamUrl(m, ua),
  };
}

function normalizeSonyLiv(m) {
  const rawStream = m.video_url || m.dai_url || null;
  const streamUrl = rawStream ? '/api/proxy?url=' + encodeURIComponent(rawStream) : null;
  // SonyLiv prefixes event_name with "Upcoming - " or "Live - " sometimes
  let cleanTitle = m.event_name || 'SonyLiv Event';
  cleanTitle = cleanTitle.replace(/^Upcoming\s*-\s*/i, '').replace(/^Live\s*-\s*/i, '');
  return {
    id: 'sonyliv:' + m.contentId,
    provider: 'SonyLiv',
    isLive: m.isLive === true,
    status: m.isLive ? 'LIVE' : 'UPCOMING',
    title: cleanTitle,
    competition: m.event_name || m.event_category || 'Unknown',
    team1: null,
    team2: null,
    category: m.event_category,
    channel: m.broadcast_channel || null,
    language: m.audioLanguageName || null,
    poster: m.src,
    startTime: null,
    startTimeMs: 0,
    streamUrl,
  };
}

async function loadMatches() {
  const [fancode, sonyliv] = await Promise.all([
    fetchJson(FANCODE_URL),
    fetchJson(SONYLIV_URL),
  ]);
  const matches = [
    ...fancode.map(normalizeFancode),
    ...sonyliv.map(normalizeSonyLiv),
  ];
  matches.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    if (a.startTimeMs && b.startTimeMs) return a.startTimeMs - b.startTimeMs;
    return 0;
  });
  return matches;
}

let allMatches = [];
let activeTab = 'live';

function renderCards(matches, grid) {
  grid.innerHTML = '';
  if (!matches || matches.length === 0) {
    grid.innerHTML = '<p class="col-span-full text-center text-sm text-muted-foreground py-16">No events in this category.</p>';
    return;
  }
  for (const m of matches) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    const providerColor = m.provider === 'Fancode' ? 'bg-blue-600/90' : 'bg-purple-600/90';
    card.innerHTML = `
      <div class="relative w-full overflow-hidden">
        ${m.poster
          ? `<img src="${m.poster}" alt="" loading="lazy" class="block w-full aspect-video object-cover" />`
          : '<div class="block w-full aspect-video bg-muted"></div>'}
        <div class="absolute inset-x-0 top-0 flex items-start justify-between p-2.5 pointer-events-none">
          <div class="flex items-center gap-1.5">
            ${m.isLive
              ? `<span class="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                  <span class="h-1.5 w-1.5 rounded-full bg-white animate-pulse-dot"></span>
                  Live
                </span>`
              : `<span class="rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-200 backdrop-blur-sm">Upcoming</span>`}
            ${m.category ? `<span class="rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-200 backdrop-blur-sm">${m.category}</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5">
            <span class="rounded-md ${providerColor} px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">${m.provider}</span>
            ${m.streamUrl ? '<span class="rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-100 backdrop-blur-sm">Stream 1</span>' : ''}
          </div>
        </div>
      </div>
      <div class="px-4 py-4 space-y-2">
        <p class="text-[14px] font-bold leading-snug text-foreground line-clamp-2">${m.title}</p>
        <p class="text-sm text-muted-foreground">
          ${m.team1 && m.team2 ? `${m.team1} vs ${m.team2}` : (m.channel ? m.channel : m.competition)}
        </p>
        <div class="flex items-center justify-between pt-1">
          <span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${m.startTime || (m.isLive ? 'Now' : 'TBA')}
          </span>
          ${m.streamUrl
            ? `<span class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white">▶ Watch</span>`
            : `<span class="text-[11px] font-medium text-yellow-500">Coming Soon</span>`}
        </div>
      </div>`;
    card.addEventListener('click', () => openPlayer(m));
    grid.appendChild(card);
  }
}

function filterAndRender() {
  const grid = document.getElementById('matches-grid');
  const filtered = allMatches.filter((m) => {
    if (activeTab === 'live') return m.isLive;
    return !m.isLive;
  });
  renderCards(filtered, grid);
}

function openPlayer(match) {
  const modal = document.getElementById('player-modal');
  const video = document.getElementById('video');
  const title = document.getElementById('player-title');
  const message = document.getElementById('player-message');

  title.textContent = match.title;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('overflow-hidden');

  if (match.poster) {
    video.poster = match.poster;
  } else {
    video.removeAttribute('poster');
  }

  if (!match.streamUrl) {
    message.textContent = 'Stream not yet available for this event.';
    message.classList.remove('hidden');
    return;
  }

  message.classList.add('hidden');
  playHls(video, match.streamUrl);
}

function playHls(video, src) {
  if (window.__hls) { window.__hls.destroy(); window.__hls = null; }

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    window.__hls = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        console.error('[HLS] Fatal error:', data.type, data.details);
        showPlayerMessage('Stream playback error: ' + data.details);
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
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
  const liveCountEl = document.getElementById('live-count');
  loader.textContent = 'Fetching live streams...';
  try {
    allMatches = await loadMatches();
    if (liveCountEl) {
      liveCountEl.textContent = allMatches.filter((m) => m.isLive).length;
    }
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
      btn.classList.add('bg-primary', 'text-white', 'shadow-sm');
      btn.classList.remove('text-muted-foreground');
    } else {
      btn.classList.remove('bg-primary', 'text-white', 'shadow-sm');
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
