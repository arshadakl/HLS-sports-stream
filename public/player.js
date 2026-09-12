const FANCODE_URL = 'https://raw.githubusercontent.com/drmlive/fancode-live-events/main/fancode.json';
const SONYLIV_URL = 'https://raw.githubusercontent.com/drmlive/sliv-live-events/main/sonyliv.json';
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const LIVE_WINDOW_BEFORE_START_MS = 15 * 60 * 1000;
const LIVE_WINDOW_AFTER_START_MS = 6 * 60 * 60 * 1000;
const LIVE_POLL_INTERVAL_MS = 60 * 1000;

const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
const isLowEndDevice = (navigator.hardwareConcurrency || 4) <= 4;
const saveDataEnabled = !!(navigator.connection && navigator.connection.saveData);

const NATIVE_ERROR_MAP = {
  1: 'Playback aborted',
  2: 'Network error — stream unreachable',
  3: 'Decode error — format unsupported',
  4: 'Source not supported on this device',
};
const NATIVE_RETRY_DELAY_MS = 1500;

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

function buildFancodeStreamUrls(m, ua) {
  // Prefer the adaptive Google master, then try the fixed media URL and the
  // Akamai master. Either CDN can reject a specific edge/region.
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

let allMatches = [];
let activeTab = 'live';
let playbackSession = 0;

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
      if (aF !== bF) return bF - aF; // football first
      return 0;
    });
  }
  renderCards(filtered, grid);
}

function openPlayer(match) {
  const modal = document.getElementById('player-modal');
  const video = document.getElementById('video');
  const title = document.getElementById('player-title');
  const message = document.getElementById('player-message');

  // Hard reset: kill any old playback and clear buffers so the previous
  // stream's segments/poster don't flash when opening a new match.
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
    return;
  }

  message.classList.add('hidden');
  playHls(video, match.streamUrls || [match.streamUrl]);
}

function isSafari() {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
}

function hidePlayerMessage() {
  document.getElementById('player-message').classList.add('hidden');
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

function playHls(video, rawSources) {
  const sources = uniqueUrls(Array.isArray(rawSources) ? rawSources : [rawSources]);
  const sessionId = ++playbackSession;
  let sourceIndex = 0;
  let attemptNumber = 0;

  const tryNextSource = (reason) => {
    if (sessionId !== playbackSession) return;
    destroyPlayback(video);

    if (sourceIndex >= sources.length) {
      console.error('[HLS] All stream sources failed:', reason);
      showPlayerMessage('Unable to play this stream on your device. Please try again later.');
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

  setInterval(() => {
    if (!allMatches.length) return;
    const changed = refreshLiveness(allMatches);
    if (liveCountEl) {
      liveCountEl.textContent = allMatches.filter((m) => m.isLive).length;
    }
    if (changed) filterAndRender();
  }, LIVE_POLL_INTERVAL_MS);
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
  resetVideo(document.getElementById('video'));
});

init();
