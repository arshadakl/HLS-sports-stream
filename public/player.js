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

function decodeHexManifest(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Invalid hex manifest');
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  const manifest = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!manifest.trimStart().startsWith('#EXTM3U')) {
    throw new Error('Decoded content is not an HLS manifest');
  }
  return manifest;
}

function parseAttributeList(line) {
  const separatorIndex = line.indexOf(':');
  const input = separatorIndex === -1 ? line : line.slice(separatorIndex + 1);
  const attributes = {};
  let index = 0;

  while (index < input.length) {
    while (index < input.length && (input[index] === ',' || /\s/.test(input[index]))) index += 1;
    if (index >= input.length) break;

    const keyStart = index;
    while (index < input.length && input[index] !== '=' && input[index] !== ',') index += 1;
    const key = input.slice(keyStart, index).trim().toUpperCase();
    if (!key || input[index] !== '=') {
      while (index < input.length && input[index] !== ',') index += 1;
      continue;
    }

    index += 1;
    let value = '';
    if (input[index] === '"') {
      index += 1;
      while (index < input.length) {
        if (input[index] === '"') {
          index += 1;
          break;
        }
        value += input[index];
        index += 1;
      }
    } else {
      const valueStart = index;
      while (index < input.length && input[index] !== ',') index += 1;
      value = input.slice(valueStart, index).trim();
    }

    attributes[key] = value;
    while (index < input.length && input[index] !== ',') index += 1;
    if (input[index] === ',') index += 1;
  }

  return attributes;
}

function resolveHttpUrl(value, baseUrl) {
  try {
    const resolved = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function findManifestBaseUrl(lines) {
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate || candidate.startsWith('#')) continue;
    const absoluteUrl = resolveHttpUrl(candidate);
    if (absoluteUrl) return absoluteUrl;
  }
  return null;
}

function parseMasterVariants(hex, ua, cdn) {
  let manifest;
  try {
    manifest = decodeHexManifest(hex);
  } catch {
    return [];
  }

  const lines = manifest.split(/\r?\n/);
  const baseUrl = findManifestBaseUrl(lines);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

    const attributes = parseAttributeList(line);
    const resolutionMatch = /^(\d+)x(\d+)$/i.exec(attributes.RESOLUTION || '');
    if (!resolutionMatch) continue;

    let uri = null;
    for (let uriIndex = index + 1; uriIndex < lines.length; uriIndex += 1) {
      const candidate = lines[uriIndex].trim();
      if (!candidate) continue;
      if (candidate.startsWith('#')) continue;
      uri = candidate;
      index = uriIndex;
      break;
    }
    if (!uri) continue;

    const rawUrl = resolveHttpUrl(uri, baseUrl);
    if (!rawUrl) continue;

    const width = Number.parseInt(resolutionMatch[1], 10);
    const height = Number.parseInt(resolutionMatch[2], 10);
    const frameRate = Number.parseFloat(attributes['FRAME-RATE']) || 0;
    const bandwidth = Number.parseInt(attributes['AVERAGE-BANDWIDTH'] || attributes.BANDWIDTH, 10) || 0;

    variants.push({
      id: '',
      label: '',
      width,
      height,
      frameRate,
      bandwidth,
      codecs: attributes.CODECS || '',
      sources: [{ cdn, url: buildUrlProxy(rawUrl, ua) }],
    });
  }

  return variants;
}

function sameRendition(a, b) {
  return a.width === b.width
    && a.height === b.height
    && Math.abs((a.frameRate || 0) - (b.frameRate || 0)) < 0.5;
}

function formatFrameRate(frameRate) {
  if (!frameRate) return '';
  return Number.isInteger(frameRate) ? String(frameRate) : frameRate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function makeVariantId(variant) {
  const fps = formatFrameRate(variant.frameRate || 0).replace('.', '-');
  return `${variant.height}p-${fps || 'unknown'}-${variant.bandwidth || 0}`;
}

function mergeQualityVariants(googleVariants, akamaiVariants) {
  const merged = (googleVariants || []).map((variant) => ({
    ...variant,
    sources: [...variant.sources],
  }));

  for (const variant of (akamaiVariants || [])) {
    const candidates = merged
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => sameRendition(item, variant) && !item.sources.some((source) => source.cdn === 'akamai'))
      .sort((a, b) => {
        const aDifference = Math.abs((a.item.bandwidth || 0) - (variant.bandwidth || 0));
        const bDifference = Math.abs((b.item.bandwidth || 0) - (variant.bandwidth || 0));
        return aDifference - bDifference;
      });

    const match = candidates[0] && merged[candidates[0].index];
    if (match) {
      for (const source of variant.sources) {
        if (!match.sources.some((existing) => existing.cdn === source.cdn && existing.url === source.url)) {
          match.sources.push(source);
        }
      }
      if (!match.codecs && variant.codecs) match.codecs = variant.codecs;
    } else {
      merged.push({ ...variant, sources: [...variant.sources] });
    }
  }

  merged.sort((a, b) => (
    b.height - a.height
    || b.frameRate - a.frameRate
    || b.bandwidth - a.bandwidth
  ));

  const usedIds = new Map();
  const heightGroups = new Map();
  for (const variant of merged) {
    const group = heightGroups.get(variant.height) || [];
    group.push(variant);
    heightGroups.set(variant.height, group);
  }

  for (const variant of merged) {
    const baseId = makeVariantId(variant);
    const duplicateNumber = usedIds.get(baseId) || 0;
    usedIds.set(baseId, duplicateNumber + 1);
    variant.id = duplicateNumber ? `${baseId}-${duplicateNumber + 1}` : baseId;

    const sameHeight = heightGroups.get(variant.height) || [];
    const minimumFrameRate = Math.min(...sameHeight.map((item) => item.frameRate || 0));
    const showFrameRate = variant.frameRate >= 45
      || (sameHeight.length > 1 && variant.frameRate > minimumFrameRate + 0.5);
    variant.label = `${variant.height}p${showFrameRate ? ` ${formatFrameRate(variant.frameRate)}fps` : ''}`;
  }

  const duplicateLabels = new Set();
  const labelCounts = merged.reduce((counts, variant) => {
    counts.set(variant.label, (counts.get(variant.label) || 0) + 1);
    return counts;
  }, new Map());
  for (const variant of merged) {
    if (labelCounts.get(variant.label) > 1 && !duplicateLabels.has(variant.id)) {
      const mbps = variant.bandwidth ? ` · ${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps` : '';
      variant.label += mbps;
      duplicateLabels.add(variant.id);
    }
    variant.sources.sort((a, b) => (a.cdn === 'google' ? -1 : 1) - (b.cdn === 'google' ? -1 : 1));
  }

  return merged;
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
  const masterSources = [
    { cdn: 'google', url: buildHexProxy(m.google_m3u8_hex, ua) },
    { cdn: 'akamai', url: buildHexProxy(m.akamai_m3u8_hex, ua) },
  ].filter((source) => source.url);
  const qualityOptions = mergeQualityVariants(
    parseMasterVariants(m.google_m3u8_hex, ua, 'google'),
    parseMasterVariants(m.akamai_m3u8_hex, ua, 'akamai'),
  );
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
    masterSources,
    qualityOptions,
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
    masterSources: [],
    qualityOptions: [],
  };
}

/* ─── State ─── */

let allMatches = [];
let activeTab = 'live';
let playbackSession = 0;
let isLoadingStream = false;
let pollIntervalId = null;
let isPageVisible = true;
let activeMatch = null;
let selectedQualityId = null;
let previouslyFocusedElement = null;

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
    const img = el('img', 'block w-full aspect-video object-cover bg-muted');
    img.src = m.poster;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
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
  if (m.isLive) {
    const liveIndicator = el('span', 'inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary');
    const pulse = el('span', 'inline-block h-2 w-2 rounded-full bg-primary animate-pulse');
    liveIndicator.appendChild(pulse);
    liveIndicator.appendChild(document.createTextNode('LIVE NOW'));
    footer.appendChild(liveIndicator);
  } else {
    const tba = el('span', 'inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80');
    tba.appendChild(document.createTextNode('Upcoming'));
    footer.appendChild(tba);
  }

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

function isSafari() {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
}

function usesNativeHls(video) {
  return !!video.canPlayType('application/vnd.apple.mpegurl')
    && (!window.Hls || !window.Hls.isSupported() || isSafari());
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
        console.warn('[HLS] Autoplay blocked by browser policy.');
        showPlayerMessage('Tap the play button to start the stream.');
      } else {
        console.warn('[HLS] Playback did not start:', (err && err.name) || 'unknown error');
      }
    });
  }
}

let nativePlaybackCleanup = null;
let playbackRetryTimerId = null;

function destroyPlayback(video) {
  if (window.__hls) { window.__hls.destroy(); window.__hls = null; }
  if (nativePlaybackCleanup) {
    nativePlaybackCleanup();
    nativePlaybackCleanup = null;
  }
  if (playbackRetryTimerId) {
    clearTimeout(playbackRetryTimerId);
    playbackRetryTimerId = null;
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

function normalizePlaybackSources(rawSources) {
  const normalized = [];
  const seen = new Set();
  const sources = Array.isArray(rawSources) ? rawSources : [rawSources];
  for (const source of sources) {
    const candidate = typeof source === 'string' ? { url: source, cdn: null } : source;
    if (!candidate || !candidate.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    normalized.push(candidate);
  }
  return normalized;
}

function findMatchingHlsLevel(levels, variant) {
  const matchingResolution = (levels || [])
    .map((level, index) => ({ level, index }))
    .filter(({ level }) => level.height === variant.height && (!variant.width || !level.width || level.width === variant.width));
  if (!matchingResolution.length) return -1;

  const levelsWithFrameRate = matchingResolution.filter(({ level }) => Number(level.frameRate) > 0);
  const matchingFrameRate = variant.frameRate && levelsWithFrameRate.length
    ? matchingResolution.filter(({ level }) => Math.abs(Number(level.frameRate) - variant.frameRate) < 0.5)
    : matchingResolution;
  if (!matchingFrameRate.length) return -1;

  matchingFrameRate.sort((a, b) => {
    const aBandwidth = Number(a.level.averageBitrate || a.level.bitrate || a.level.maxBitrate || 0);
    const bBandwidth = Number(b.level.averageBitrate || b.level.bitrate || b.level.maxBitrate || 0);
    return Math.abs(aBandwidth - variant.bandwidth) - Math.abs(bBandwidth - variant.bandwidth);
  });
  return matchingFrameRate[0].index;
}

function seekToLiveEdge(video) {
  try {
    if (!video.seekable || video.seekable.length === 0) return;
    const liveEdge = video.seekable.end(video.seekable.length - 1);
    if (Number.isFinite(liveEdge)) video.currentTime = Math.max(0, liveEdge - 0.5);
  } catch {
    // Some native HLS implementations reject seeks until playback begins.
  }
}

function playHls(video, rawSources, options = {}) {
  const sources = normalizePlaybackSources(rawSources);
  const sessionId = ++playbackSession;
  let sourceIndex = 0;
  let attemptNumber = 0;

  const tryNextSource = (reason) => {
    if (sessionId !== playbackSession) return;
    destroyPlayback(video);

    if (sourceIndex >= sources.length) {
      console.error('[HLS] All stream sources failed.');
      if (options.onExhausted) options.onExhausted(reason);
      return;
    }

    const candidate = sources[sourceIndex++];
    if (options.onSourceAttempt) options.onSourceAttempt();
    const currentAttempt = ++attemptNumber;
    const isCurrent = () => sessionId === playbackSession && currentAttempt === attemptNumber;
    let candidateFailed = false;

    const failCandidate = (failureReason) => {
      if (!isCurrent() || candidateFailed) return;
      candidateFailed = true;
      console.warn('[HLS] Stream source failed; trying the next safe fallback.');
      if (options.onRetry) options.onRetry();
      if (sourceIndex < sources.length) {
        showPlayerMessage('Primary stream unavailable. Trying a backup…');
      }
      if (nativePlaybackCleanup) {
        nativePlaybackCleanup();
        nativePlaybackCleanup = null;
      }
      playbackRetryTimerId = setTimeout(() => {
        playbackRetryTimerId = null;
        tryNextSource(failureReason);
      }, NATIVE_RETRY_DELAY_MS);
    };

    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}

    // iOS browsers use the native HLS media stack rather than MediaSource.
    if (usesNativeHls(video)) {
      const onNativeError = () => {
        const errorCode = video.error && video.error.code;
        const msg = NATIVE_ERROR_MAP[errorCode] || ('native media error ' + (errorCode || 'unknown'));
        failCandidate(msg);
      };
      const onNativeReady = () => {
        if (!isCurrent()) return;
        if (options.resumeAtLiveEdge) seekToLiveEdge(video);
        if (options.onReady) options.onReady();
        if (options.shouldAutoplay) tryAutoplay(video, isCurrent);
      };
      nativePlaybackCleanup = () => {
        video.removeEventListener('error', onNativeError);
        video.removeEventListener('canplay', onNativeReady);
      };
      video.addEventListener('error', onNativeError, { once: true });
      video.addEventListener('canplay', onNativeReady, { once: true });
      video.src = candidate.url;
      try { video.load(); } catch (e) {}
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      let mediaRecoveryAttempts = 0;
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        startLevel: -1,
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
      hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(candidate.url));
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (!isCurrent()) return;
        if (options.variant) {
          const targetLevel = findMatchingHlsLevel(hls.levels, options.variant);
          if (targetLevel < 0) {
            failCandidate('selected rendition is absent from this source');
            return;
          }
          hls.currentLevel = targetLevel;
        } else {
          hls.currentLevel = -1;
        }
        if (options.onReady) options.onReady();
        if (options.shouldAutoplay) tryAutoplay(video, isCurrent);
      });
      hls.on(window.Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (!isCurrent() || !options.onLevelSwitched) return;
        const level = hls.levels && hls.levels[data.level];
        options.onLevelSwitched(level || null);
      });
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

function setQualityControlLoading(isLoading) {
  const select = document.getElementById('quality-select');
  select.disabled = isLoading;
  select.setAttribute('aria-busy', String(isLoading));
  isLoadingStream = isLoading;
}

function setAutoQualityLabel(height) {
  const select = document.getElementById('quality-select');
  const autoOption = Array.from(select.options).find((option) => option.value === 'auto');
  if (autoOption) autoOption.textContent = height ? `Auto (${height}p)` : 'Auto';
}

function resetQualityUi() {
  const chooser = document.getElementById('quality-chooser');
  const options = document.getElementById('quality-options');
  const controls = document.getElementById('quality-controls');
  const select = document.getElementById('quality-select');
  const shell = document.getElementById('video-shell');
  chooser.classList.add('hidden');
  controls.classList.add('hidden');
  controls.classList.remove('flex');
  shell.classList.remove('is-choosing');
  options.replaceChildren();
  select.replaceChildren();
  select.disabled = false;
  select.removeAttribute('aria-busy');
}

function createQualityButton(qualityId, label, detail) {
  const button = el('button', 'quality-option min-h-11 rounded-lg border border-white/15 bg-black/55 px-3 py-2 text-center text-sm font-semibold text-white backdrop-blur-sm transition hover:border-primary hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary');
  button.type = 'button';
  button.dataset.qualityId = qualityId;
  button.setAttribute('aria-label', detail ? `${label} (${detail})` : label);
  button.appendChild(el('span', 'block', label));
  if (detail) button.appendChild(el('span', 'mt-0.5 block text-[10px] font-medium uppercase tracking-wider text-slate-300', detail));
  return button;
}

function renderQualityChooser(match) {
  const chooser = document.getElementById('quality-chooser');
  const options = document.getElementById('quality-options');
  const shell = document.getElementById('video-shell');
  options.replaceChildren();
  options.appendChild(createQualityButton('auto', 'Auto', 'Recommended'));
  for (const variant of match.qualityOptions) {
    options.appendChild(createQualityButton(variant.id, variant.label));
  }
  shell.classList.add('is-choosing');
  chooser.classList.remove('hidden');
  const firstOption = options.querySelector('button');
  if (firstOption) firstOption.focus({ preventScroll: true });
}

function populateQualityControl(match, qualityId) {
  const controls = document.getElementById('quality-controls');
  const select = document.getElementById('quality-select');
  select.replaceChildren();

  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = 'Auto';
  select.appendChild(autoOption);
  for (const variant of match.qualityOptions) {
    const option = document.createElement('option');
    option.value = variant.id;
    option.textContent = variant.label;
    select.appendChild(option);
  }
  select.value = qualityId;
  controls.classList.remove('hidden');
  controls.classList.add('flex');
}

function getQualityVariant(match, qualityId) {
  if (!match || qualityId === 'auto') return null;
  return match.qualityOptions.find((variant) => variant.id === qualityId) || null;
}

function manualPlaybackSources(match, variant, nativeHls) {
  if (nativeHls) return variant.sources;
  return variant.sources.map((source) => (
    match.masterSources.find((master) => master.cdn === source.cdn)
  )).filter(Boolean);
}

function startPlayback(match, qualityId, shouldAutoplay) {
  if (!match || match !== activeMatch) return;
  const video = document.getElementById('video');
  const select = document.getElementById('quality-select');
  const variant = getQualityVariant(match, qualityId);

  if (qualityId !== 'auto' && !variant) {
    showPlayerMessage('Selected quality is no longer available. Switching to Auto…');
    qualityId = 'auto';
  }

  const manualSelection = qualityId !== 'auto';
  selectedQualityId = qualityId;
  if (select.options.length) select.value = qualityId;
  setAutoQualityLabel(null);
  setQualityControlLoading(true);
  showPlayerMessage(manualSelection ? 'Loading selected quality…' : 'Loading stream…');

  const selectedVariant = getQualityVariant(match, qualityId);
  const nativeHls = usesNativeHls(video);
  const sources = selectedVariant
    ? manualPlaybackSources(match, selectedVariant, nativeHls)
    : (match.streamUrls || [match.streamUrl]);

  playHls(video, sources, {
    variant: selectedVariant,
    shouldAutoplay,
    resumeAtLiveEdge: nativeHls && selectedQualityId !== null,
    onSourceAttempt: () => {
      if (qualityId === 'auto' && selectedQualityId === 'auto') setAutoQualityLabel(null);
    },
    onRetry: () => {
      if (match === activeMatch && qualityId === selectedQualityId) setQualityControlLoading(true);
    },
    onReady: () => {
      if (match !== activeMatch || qualityId !== selectedQualityId) return;
      setQualityControlLoading(false);
      hidePlayerMessage();
    },
    onLevelSwitched: (level) => {
      if (qualityId !== 'auto' || selectedQualityId !== 'auto') return;
      setAutoQualityLabel(level && level.height);
    },
    onExhausted: () => {
      if (match !== activeMatch || qualityId !== selectedQualityId) return;
      if (qualityId !== 'auto') {
        selectedQualityId = 'auto';
        if (select.options.length) select.value = 'auto';
        setAutoQualityLabel(null);
        showPlayerMessage('Selected quality unavailable. Switching to Auto…');
        playbackRetryTimerId = setTimeout(() => {
          playbackRetryTimerId = null;
          if (match === activeMatch && selectedQualityId === 'auto') {
            startPlayback(match, 'auto', shouldAutoplay);
          }
        }, NATIVE_RETRY_DELAY_MS);
        return;
      }
      setQualityControlLoading(false);
      showPlayerMessage('Unable to play this stream on your device. Please try again later.');
    },
  });
}

function chooseQuality(qualityId) {
  if (!activeMatch) return;
  const variant = getQualityVariant(activeMatch, qualityId);
  if (qualityId !== 'auto' && !variant) return;

  const video = document.getElementById('video');
  const wasPlaying = selectedQualityId === null || (!video.paused && !video.ended);
  const chooser = document.getElementById('quality-chooser');
  const shell = document.getElementById('video-shell');

  if (qualityId === 'auto' && window.__hls) {
    window.__hls.currentLevel = -1;
  }

  chooser.classList.add('hidden');
  shell.classList.remove('is-choosing');
  populateQualityControl(activeMatch, qualityId);
  startPlayback(activeMatch, qualityId, wasPlaying);
}

function showPosterOverlay(shell, posterSrc) {
  let overlay = document.getElementById('poster-overlay');
  if (!overlay) {
    overlay = document.createElement('img');
    overlay.id = 'poster-overlay';
    overlay.className = 'absolute inset-0 w-full h-full object-contain bg-black';
    overlay.referrerPolicy = 'no-referrer';
    overlay.alt = '';
    shell.appendChild(overlay);
  }
  overlay.src = posterSrc || '';
  overlay.classList.remove('hidden');
}

function hidePosterOverlay() {
  const overlay = document.getElementById('poster-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function hideUpcomingView() {
  const view = document.getElementById('upcoming-view');
  if (view) view.classList.add('hidden');
}

function showUpcomingView() {
  const view = document.getElementById('upcoming-view');
  if (view) view.classList.remove('hidden');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}

const UPCOMING_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UPCOMING_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatUpcomingStart(match) {
  // Prefer the parsed timestamp (IST); fall back to the raw string.
  let ts = match.startTimeMs;
  if (typeof ts !== 'number' || ts <= 0) {
    ts = parseFancodeTime(match.startTime);
  }
  if (!ts) return 'Starts soon';

  const now = Date.now();
  const diffMs = ts - now;
  const absDiff = Math.abs(diffMs);
  const minutes = Math.round(absDiff / 60000);
  const hours = Math.round(absDiff / 3600000);
  const days = Math.floor(absDiff / 86400000);

  if (diffMs > 0 && minutes < 60) return `Starts in ${minutes} min`;
  if (diffMs > 0 && hours < 24) return `Starts in ${hours} hr`;
  if (diffMs > 0 && days < 7) return `Starts in ${days} day${days === 1 ? '' : 's'}`;

  // Past or far future — show the absolute date/time.
  const d = new Date(ts);
  const wd = UPCOMING_WEEKDAYS[d.getUTCDay()];
  const day = d.getUTCDate();
  const mon = UPCOMING_MONTHS[d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const prefix = diffMs > 0 ? 'Starts' : 'Started';
  return `${prefix} ${wd} ${day} ${mon} · ${hh}:${mm} IST`;
}

function renderUpcomingView(match) {
  const poster = document.getElementById('upcoming-poster');
  if (poster) {
    poster.src = match.poster || '';
    poster.alt = match.title || '';
  }
  setText('upcoming-competition', match.competition || match.category || '');
  setText('upcoming-title', match.title || '');
  const matchup = (match.team1 && match.team2)
    ? `${match.team1} vs ${match.team2}`
    : (match.channel || '');
  setText('upcoming-matchup', matchup);
  setText('upcoming-start', formatUpcomingStart(match));
}

function openPlayer(match) {
  if (isLoadingStream) return;

  const modal = document.getElementById('player-modal');
  const video = document.getElementById('video');
  const title = document.getElementById('player-title');
  const message = document.getElementById('player-message');

  previouslyFocusedElement = document.activeElement;
  resetVideo(video);
  resetQualityUi();
  activeMatch = match;
  selectedQualityId = null;

  title.textContent = match.title;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('overflow-hidden');

  if (match.poster) video.poster = match.poster;

  // Upcoming matches: hide the <video> element entirely and show a
  // poster-driven "Coming Soon" view — no player chrome, no controls,
  // no loading state, no "stream not available" text.
  if (!match.isLive) {
    video.removeAttribute('controls');
    video.style.display = 'none';
    hidePlayerMessage();
    hidePosterOverlay();
    renderUpcomingView(match);
    showUpcomingView();
    document.getElementById('close-player').focus({ preventScroll: true });
    return;
  }

  // Live matches: restore the video element, hide the upcoming view.
  video.style.display = '';
  video.setAttribute('controls', '');
  hidePosterOverlay();
  hideUpcomingView();

  if (!match.streamUrl) {
    message.textContent = 'Stream not yet available for this event.';
    message.classList.remove('hidden');
    document.getElementById('close-player').focus({ preventScroll: true });
    return;
  }

  message.classList.add('hidden');
  if (match.qualityOptions.length >= 2) {
    renderQualityChooser(match);
    return;
  }

  selectedQualityId = 'auto';
  startPlayback(match, 'auto', true);
}

function closePlayer() {
  const modal = document.getElementById('player-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.classList.remove('overflow-hidden');
  const video = document.getElementById('video');
  resetVideo(video);
  resetQualityUi();
  video.style.display = '';
  video.setAttribute('controls', '');
  hidePosterOverlay();
  hideUpcomingView();
  activeMatch = null;
  selectedQualityId = null;
  isLoadingStream = false;
  if (previouslyFocusedElement && previouslyFocusedElement.isConnected) {
    previouslyFocusedElement.focus({ preventScroll: true });
  }
  previouslyFocusedElement = null;
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
  const modal = document.getElementById('player-modal');
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closePlayer();
}

function handleQualityChoice(e) {
  const button = e.target.closest('[data-quality-id]');
  if (!button) return;
  chooseQuality(button.dataset.qualityId);
}

function handleQualityChange(e) {
  if (!activeMatch || e.target.disabled || e.target.value === selectedQualityId) return;
  chooseQuality(e.target.value);
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
  document.getElementById('quality-options').addEventListener('click', handleQualityChoice);
  document.getElementById('quality-select').addEventListener('change', handleQualityChange);
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
