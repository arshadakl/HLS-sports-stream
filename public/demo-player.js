async function loadManifest() {
  const res = await fetch('/streams.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('manifest fetch failed');
  return res.json();
}

function renderCards(matches, grid) {
  grid.innerHTML = '';
  if (!matches || matches.length === 0) {
    grid.innerHTML = '<p class="text-slate-400">No events.</p>';
    return;
  }
  for (const m of matches) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className =
      'text-left rounded-xl border border-slate-700 bg-slate-900/60 p-4 hover:border-red-500 transition';
    card.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <span class="inline-flex items-center gap-1.5 text-xs font-bold ${m.status === 'LIVE' ? 'bg-red-600' : 'bg-slate-600'} text-white px-2 py-0.5 rounded">
          ${m.status === 'LIVE' ? '<span class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>' : ''}${m.status}
        </span>
      </div>
      <h3 class="font-semibold text-white">${m.title}</h3>
      <p class="text-sm text-slate-400 mt-1">${(m.teams || []).join(' vs ')}</p>`;
    card.addEventListener('click', () => openPlayer(m));
    grid.appendChild(card);
  }
}

function openPlayer(match) {
  const modal = document.getElementById('player-modal');
  const video = document.getElementById('video');
  const title = document.getElementById('player-title');
  const message = document.getElementById('player-message');

  title.textContent = match.title;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('modal-open');

  if (!match.stream) {
    message.classList.remove('hidden');
    return;
  }

  message.classList.add('hidden');
  playHls(video, match.stream);
}

function playHls(video, src) {
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls();
    if (window.__hls) window.__hls.destroy();
    window.__hls = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    video.play().catch(() => {});
  }
}

async function init() {
  const grid = document.getElementById('matches-grid');
  const loader = document.getElementById('loader');
  try {
    const data = await loadManifest();
    renderCards(data.matches, grid);
    grid.classList.remove('hidden');
    loader.classList.add('hidden');
  } catch (e) {
    loader.innerHTML = '<p class="text-red-400">Failed to load manifest.</p>';
  }
}

document.getElementById('close-player').addEventListener('click', () => {
  document.getElementById('player-modal').classList.add('hidden');
  document.getElementById('player-modal').classList.remove('flex');
  document.body.classList.remove('modal-open');
  if (window.__hls) { window.__hls.destroy(); window.__hls = null; }
  const video = document.getElementById('video');
  video.pause();
  video.removeAttribute('src');
});

init();
