import type { APIRoute } from 'astro';

export const prerender = false;

const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function rewriteM3u8(body: string, baseOrigin: string, basePath: string): string {
  const base = baseOrigin + basePath.substring(0, basePath.lastIndexOf('/') + 1);
  return body.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    let abs: string;
    try { abs = new URL(trimmed, base).toString(); } catch { return line; }
    return `/api/proxy?url=${encodeURIComponent(abs)}`;
  }).join('\n');
}

export const GET: APIRoute = async ({ url }) => {
  const target = url.searchParams.get('url');
  const hex = url.searchParams.get('hex');
  const ua = url.searchParams.get('ua') || DEFAULT_UA;

  // Mode 1: decode hex m3u8 and serve as m3u8 manifest
  if (hex) {
    try {
      const m3u8 = Buffer.from(hex, 'hex').toString('utf-8');
      const headers: Record<string, string> = {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };
      // For the rewritten playlist, we don't know the base origin/path of
      // the original URL — segments in hex playlists are typically relative
      // to the same CDN host. We leave relative URLs as-is since the client
      // resolves them against the proxy origin.
      return new Response(m3u8, { status: 200, headers });
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid hex' }), { status: 400 });
    }
  }

  // Mode 2: proxy a remote URL
  if (!target) {
    return new Response(JSON.stringify({ error: 'Missing url or hex param' }), { status: 400 });
  }

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid url' }), { status: 400 });
  }

  const resp = await fetch(remoteUrl.toString(), {
    headers: { 'User-Agent': ua },
  });

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  if (contentType.includes('mpegurl') || contentType.includes('m3u8') || target.endsWith('.m3u8')) {
    const body = await resp.text();
    return new Response(rewriteM3u8(body, remoteUrl.origin, remoteUrl.pathname), { status: resp.status, headers });
  }

  return new Response(resp.body, { status: resp.status, headers });
};
