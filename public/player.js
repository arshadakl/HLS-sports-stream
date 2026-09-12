const FANCODE_URL = 'https://raw.githubusercontent.com/drmlive/fancode-live-events/main/fancode.json';
const SONYLIV_URL = 'https://raw.githubusercontent.com/drmlive/sliv-live-events/main/sonyliv.json';
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const LIVE_WINDOW_BEFORE_START_MS = 15 * 60 * 1000;
const LIVE_WINDOW_AFTER_START_MS = 6 * 60 * 60 * 1000;
const LIVE_POLL_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_RETRIES = 2;
const NATIVE_RETRY_DELAY_MS = 1500;

const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
const isLowEndDevice = (navigator.hardwareConcurrency || 4) <= 4;
const saveDataEnabled = !!(navigator.connection && navigator.connection.saveData);

const NATIVE_ERROR_MAP = {
  1: 'Playback aborted',
  2: 'Network error — stream unreachable',
  3: 'Decode error — format unsupported',
  4: 'Source not supported on this device',
};

/* ─── Utils ─── */

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svgIconCalendar() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'h-3 w-3');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.innerHTML = '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>';
  return s;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ─── Network ─── */

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, attempt = 0) {
  try {
    const res = await fetchWithTimeout(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.matches) ? data.matches : [];
  } catch (err) {
    if (attempt < MAX_FETCH_RETRIES) {
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
      return fetchJson(url, attempt + 1);
    }
    console.error('[fetchJson] Failed after retries:', url, err);
    return [];
  }
}

/* ─── Time / Live Logic ─── */

function parseFancodeTime(str) {
  if (!str) return 0;
  const match = str.match(/(\d{2}):(\d{2}):(\d{2})\s(AM|PM)\s(\d{2})-(\d{2})-(\d{4})/i);
  if (!match) return 0;
  let [, hh, mm, ss, ampm, DD, MM, YYYY] = match;
  hh = parseInt(hh, 10);
  if (ampm.toUpperCase() === 'PM' && hh < 12) hh += 12;
  if (ampm.toUpperCase() === 'AM' && hh === 12) hh = 0;
  // Parse as IST (+05:30) since the upstream format uses IST
  return new Date(`${YYYY}-${MM}-${DD}T${String(hh).padStart(2, '0')}:${mm}:${ss}+05:30`).getTime();
}

function computeIsLive({ provider, startTimeMs, upstreamStatus, upstreamIsLive }) {
  const status = (upstreamStatus || '').toUpperCase();
  const hasStartTime = typeof startTimeMs === 'number' && startTimeMs > 0;

  if (status === 'UPCOMING') return false;
  if (status === 'ENDED' || status === 'COMPLETED' || status === 'FINISHED') return false;

  if (!hasStartTime) {
    return upstreamIsLive === true;
  }

  const now = Date.now();
  if (now < startTimeMs - LIVE_WINDOW_BEFORE_START_MS) return false;
  if (now > startTimeMs + LIVE_WINDOW_AFTER_START_MS) return false;

  if (status === 'LIVE') return true;
  return upstreamIsLive === true;
}

/* ─── Proxy Builders ─── */

function buildUrlProxy(rawUrl, ua) {
  if (!rawUrl) return null;
  const params = new URLSearchParams({ url: rawUrl });
  if (ua) params.set('ua', ua);
  return '/api/proxy?' + params.toString();
}

function buildHexProxy(hex, ua) {
  if (!hex) return null;
  const params = new URLSearchParams({ hex });
  if (ua) params.set('ua', ua);
  return '/api/proxy?' + params.toString();
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

/* ─── Normalizers ─── */

function buildFancodeStreamUrls(m, ua) {
  return uniqueUrls([
    buildHexProxy(m.google_m3u8_hex, ua),
    buildUrlProxy(m.dai_url, ua),
    buildUrlProxy(m.adfree_url, ua),
    buildHexProxy(m.akamai_m3u8_hex, ua),
  ]);
}

function buildSonyLivStreamUrls(m) {
  return uniqueUrls([
    buildUrlProxy(m.video_url),
    buildUrlProxy(m.dai_url),
    buildUrlProxy(m.pub_url),
  ]);
}

function normalizeFancode(m) {
  const ua = m['user-agent'] || DEFAULT_UA;
  const streamUrls = buildFancodeStreamUrls(m, ua);
  const startTimeMs = parseFancodeTime(m.startTime);
  const isLive = computeIsLive({
    provider: 'Fancode',
    startTimeMs,
    upstreamStatus: m.status,
    upstreamIsLive: m.status === 'LIVE',
  });
  return {
    id: 'fancode:' + m.match_id,
    provider: 'Fancode',
    isLive,
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
    startTimeMs,
    streamUrls,
    streamUrl: streamUrls[0] || null,
  };
}

function normalizeSonyLiv(m) {
  const streamUrls = buildSonyLivStreamUrls(m);
  let cleanTitle = m.event_name || 'SonyLiv Event';
  cleanTitle = cleanTitle.replace(/^Upcoming\s*-\s*/i, '').replace(/^Live\s*-\s*/i, '');
  const isLive = computeIsLive({
    provider: 'SonyLiv',
    startTimeMs: 0,
    upstreamStatus: m.isLive ? 'LIVE' : 'UPCOMING',
    upstreamIsLive: m.isLive === true,
  });
  return {
    id: 'sonyliv:' + m.contentId,
    provider: 'SonyLiv',
    isLive,
    status: isLive ? 'LIVE' : 'UPCOMING',
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
    streamUrls,
    streamUrl: streamUrls[0] || null,
  };
}

/* ─── State ─── */

let allMatches = [];
let activeTab = 'live';
let playbackSession = 0;
let isLoadingStream = false;
let pollIntervalId = null;
let isPageVisible = true;

/* ─── Data Loading ─── */

async function loadMatches() {
  const fancode = await fetchJson(FANCODE_URL);
  // SonyLiv temporarily hidden — re-enable by uncommenting below:
  // const sonyliv = await fetchJson(SONYLIV_URL);
  const matches = [
    ...fancode.map(normalizeFancode),
    // ...sonyliv.map(normalizeSonyLiv),
  ];
  matches.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    if (a.startTimeMs && b.startTimeMs) return a.startTimeMs - b.startTimeMs;
    return 0;
  });
  return matches;
}

function refreshLiveness(matches) {
  let changed = false;
  for (const m of matches) {
    const next = computeIsLive({
      provider: m.provider,
      startTimeMs: m.startTimeMs,
      upstreamStatus: m.status,
      upstreamIsLive: m.status === 'LIVE' || m.isLive,
    });
    if (next !== m.isLive) {
      m.isLive = next;
      m.status = next ? 'LIVE' : 'UPCOMING';
      changed = true;
    }
  }
  if (changed) {
    matches.sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      if (a.startTimeMs && b.startTimeMs) return a.startTimeMs - b.startTimeMs;
      return 0;
    });
  }
  return changed;
}

/* ─── Rendering (XSS-safe) ─── */

function renderBadge(text, classes) {
  const span = el('span', `rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${classes}`);
  span.textContent = text;
  return span;
}

function renderCard(m) {
  const card = el('button', 'card');
  card.type = 'button';
  card.dataset.matchId = m.id;
  card.setAttribute('aria-label', `Watch ${m.title}`);

  // Image container
  const imgWrap = el('div', 'relative w-full overflow-hidden');

  if (m.poster) {
    const img = el('img', 'block w-full aspect-video object-cover');
    img.src = m.poster;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { img.style.display = 'none'; };
    imgWrap.appendChild(img);
  } else {
    const placeholder = el('div', 'block w-full aspect-video bg-muted');
    imgWrap.appendChild(placeholder);
  }

  // Overlays
  const overlay = el('div', 'absolute inset-x-0 top-0 flex items-start justify-between p-2.5 pointer-events-none');
  const left = el('div', 'flex items-center gap-1.5');

  if (m.isLive) {
    const liveBadge = renderBadge('Live', 'bg-primary text-white');
    const dot = el('span', 'h-1.5 w-1.5 rounded-full bg-white animate-pulse');
    liveBadge.prepend(dot);
    left.appendChild(liveBadge);
  } else {
    left.appendChild(renderBadge('Upcoming', 'bg-black/70 text-slate-200 backdrop-blur-sm'));
  }

  if (m.category) {
    left.appendChild(renderBadge(m.category, 'bg-black/70 text-slate-200 backdrop-blur-sm font-semibold'));
  }

  const right = el('div', 'flex items-center gap-1.5');
  const providerColor = m.provider === 'Fancode' ? 'bg-blue-600/90' : 'bg-purple-600/90';
  right.appendChild(renderBadge(m.provider, `${providerColor} text-white backdrop-blur-sm`));
  if (m.streamUrl) {
    right.appendChild(renderBadge('Stream 1', 'bg-black/70 text-slate-100 backdrop-blur-sm font-semibold'));
  }

  overlay.appendChild(left);
  overlay.appendChild(right);
  imgWrap.appendChild(overlay);
  card.appendChild(imgWrap);

  // Body
  const body = el('div', 'px-4 py-4 space-y-2');

  const title = el('p', 'text-[14px] font-bold leading-snug text-foreground line-clamp-2');
  title.textContent = m.title;
  body.appendChild(title);

  const subtitle = el('p', 'text-sm text-muted-foreground');
  subtitle.textContent = (m.team1 && m.team2) ? `${m.team1} vs ${m.team2}` : (m.channel || m.competition);
  body.appendChild(subtitle);

  const footer = el('div', 'flex items-center justify-between pt-1');
  const timeWrap = el('span', 'inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80');
  timeWrap.appendChild(svgIconCalendar());
  timeWrap.appendChild(document.createTextNode(m.startTime || (m.isLive ? 'Now' : 'TBA')));
  footer.appendChild(timeWrap);

  if (m.streamUrl) {
    const watch = el('span', 'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white');
    watch.textContent = '▶ Watch';
    footer.appendChild(watch);
  } else {
    const soon = el('span', 'text-[11px] font-medium text-yellow-500');
    soon.textContent = 'Coming Soon';
    footer.appendChild(soon);
  }

  body.appendChild(footer);
  card.appendChild(body);

  return card;
}

function renderCards(matches, grid) {
  grid.innerHTML = '';
  if (!matches || matches.length === 0) {
    const empty = el('p', 'col-span-full text-center text-sm text-muted-foreground py-16');
    empty.textContent = 'No events in this category.';
    grid.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const m of matches) {
    frag.appendChild(renderCard(m));
  }
  grid.appendChild(frag);
}

function filterAndRender() {
  const grid = document.getElementById('matches-grid');
  let filtered = allMatches.filter((m) => {
    if (activeTab === 'live') return m.isLive;
    return !m.isLive;
  });
  // In the Live tab, show Football matches first, then everything else.
  if (activeTab === 'live') {
    const isFootball = (m) => (m.category || '').toLowerCase() === 'football';
    filtered.sort((a, b) => {
      const aF = isFootball(a) ? 1 : 0;
      const bF = isFootball(b) ? 1 : 0;
      if (aF !== bF) return bF - aF;
      return 0;
    });
  }
  renderCards(filtered, grid);
}

/* ─── Player ─── */

function openPlayer(match) {
  if (isLoadingStream) return;
  isLoadingStream = true;

  const modal = document.getElementById('player-modal');
  const video = document.getElementById('video');
  const title = document.getElementById('player-title');
  const message = document.getElementById('player-message');

  resetVideo(video);

  title.textContent = match.title;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('overflow-hidden');

  if (match.poster) {
    video.poster = match.poster;
  }

  if (!match.streamUrl) {
    message.textContent = 'Stream not yet available for this event.';
    message.classList.remove('hidden');
    isLoadingStream = false;
    return;
  }

  message.classList.add('hidden');
  playHls(video, match.streamUrls || [match.streamUrl], () => {
    isLoadingStream = false;
  });
}

function closePlayer() {
  const modal = document.getElementById('player-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.classList.remove('overflow-hidden');
  resetVideo(document.getElementById('video'));
  isLoadingStream = false;
}

function isSafari() {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
}

function hidePlayerMessage() {
  document.getElementById('player-message').classList.add('hidden');
}

function showPlayerMessage(msg) {
  const el = document.getElementById('player-message');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function tryAutoplay(video, isCurrent = () => true) {
  const p = video.play();
  if (p && typeof p.then === 'function') {
    p.then(() => {
      if (isCurrent()) hidePlayerMessage();
    }).catch((err) => {
      if (!isCurrent()) return;
      if (err && err.name === 'NotAllowedError') {
        console.warn('[HLS] Autoplay blocked, user gesture required:', err);
        showPlayerMessage('Tap the play button to start the stream.');
      } else {
        console.warn('[HLS] Playback did not start:', err);
      }
    });
  }
}

function destroyPlayback(video) {
  if (window.__hls) { window.__hls.destroy(); window.__hls = null; }
  if (window.__nativeHlsErrorHandler) {
    video.removeEventListener('error', window.__nativeHlsErrorHandler);
    window.__nativeHlsErrorHandler = null;
  }
}

function resetVideo(video) {
  playbackSession += 1;
  destroyPlayback(video);
  video.pause();
  video.removeAttribute('src');
  video.removeAttribute('poster');
  try { video.load(); } catch (e) {}
  hidePlayerMessage();
}

function playHls(video, rawSources, onDone) {
  const sources = uniqueUrls(Array.isArray(rawSources) ? rawSources : [rawSources]);
  const sessionId = ++playbackSession;
  let sourceIndex = 0;
  let attemptNumber = 0;

  const tryNextSource = (reason) => {
    if (sessionId !== playbackSession) {
      if (onDone) onDone();
      return;
    }
    destroyPlayback(video);

    if (sourceIndex >= sources.length) {
      console.error('[HLS] All stream sources failed:', reason);
      showPlayerMessage('Unable to play this stream on your device. Please try again later.');
      if (onDone) onDone();
      return;
    }

    const src = sources[sourceIndex++];
    const currentAttempt = ++attemptNumber;
    const isCurrent = () => sessionId === playbackSession && currentAttempt === attemptNumber;
    let candidateFailed = false;

    const failCandidate = (failureReason) => {
      if (!isCurrent() || candidateFailed) return;
      candidateFailed = true;
      console.warn('[HLS] Stream source failed:', failureReason);
      if (sourceIndex < sources.length) {
        showPlayerMessage('Primary stream unavailable. Trying a backup…');
      }
      setTimeout(() => tryNextSource(failureReason), NATIVE_RETRY_DELAY_MS);
    };

    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}

    // iOS browsers use the native HLS media stack rather than MediaSource.
    if (video.canPlayType('application/vnd.apple.mpegurl') && (!window.Hls || !window.Hls.isSupported() || isSafari())) {
      const onNativeError = () => {
        const errorCode = video.error && video.error.code;
        const msg = NATIVE_ERROR_MAP[errorCode] || ('native media error ' + (errorCode || 'unknown'));
        failCandidate(msg);
      };
      window.__nativeHlsErrorHandler = onNativeError;
      video.addEventListener('error', onNativeError, { once: true });
      video.addEventListener('canplay', () => tryAutoplay(video, isCurrent), { once: true });
      video.src = src;
      try { video.load(); } catch (e) {}
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      let mediaRecoveryAttempts = 0;
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        maxAutoLevelCapping: isMobileUA ? 480 : -1,
        startLevel: isMobileUA ? -1 : -1,
        backBufferLength: isMobileUA ? 30 : 60,
        maxBufferLength: isMobileUA ? 20 : 30,
        maxMaxBufferLength: isMobileUA ? 60 : 120,
        maxBufferSize: isMobileUA ? 30 * 1000 * 1000 : 60 * 1000 * 1000,
        maxFragLoadingTimeMs: 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 1000,
        abrEwmaDefaultEstimate: isLowEndDevice ? 500000 : 1000000,
        abrBandWidthFactor: 0.9,
        abrBandWidthUpFactor: isMobileUA ? 0.6 : 0.7,
        liveSyncDurationCount: isMobileUA ? 2 : 3,
        liveMaxLatencyDurationCount: isMobileUA ? 5 : 6,
        enableSoftwareAES: !window.isSecureContext,
        progressive: false,
      });
      if (saveDataEnabled) {
        hls.config.startLevel = 0;
      }
      window.__hls = hls;
      hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => tryAutoplay(video, isCurrent));
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (!isCurrent()) return;
        console.warn('[HLS] error:', data.type, data.details, data.fatal);
        if (!data.fatal) return;

        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 1) {
          mediaRecoveryAttempts += 1;
          hls.recoverMediaError();
          return;
        }

        failCandidate(data.details || data.type);
      });
      hls.attachMedia(video);
      return;
    }

    failCandidate('HLS is not supported in this browser');
  };

  tryNextSource('initial source');
}

/* ─── Event Delegation ─── */

function handleGridClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const matchId = card.dataset.matchId;
  const match = allMatches.find(m => m.id === matchId);
  if (match) openPlayer(match);
}

function handleModalBackdrop(e) {
  if (e.target === e.currentTarget) closePlayer();
}

function handleKeyDown(e) {
  if (e.key === 'Escape') closePlayer();
}

/* ─── Init ─── */

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

async function init() {
  const grid = document.getElementById('matches-grid');
  const loader = document.getElementById('loader');
  const liveCountEl = document.getElementById('live-count');
  loader.textContent = 'Fetching live streams...';

  // Event delegation for cards (XSS-safe, no memory leaks)
  grid.addEventListener('click', handleGridClick);

  // Modal interactions
  document.getElementById('player-modal').addEventListener('click', handleModalBackdrop);
  document.getElementById('close-player').addEventListener('click', closePlayer);
  document.addEventListener('keydown', handleKeyDown);

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

  // Polling with Page Visibility API
  pollIntervalId = setInterval(() => {
    if (!isPageVisible || !allMatches.length) return;
    const changed = refreshLiveness(allMatches);
    if (liveCountEl) {
      liveCountEl.textContent = allMatches.filter((m) => m.isLive).length;
    }
    if (changed) filterAndRender();
  }, LIVE_POLL_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;
  });
}

init();
