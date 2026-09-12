import type { APIRoute } from 'astro';

export const prerender = false;

const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Build a proxy URL for a given absolute remote URL and UA
function proxyUrlFor(remoteUrl: string, ua: string): string {
  const params = new URLSearchParams({ url: remoteUrl });
  if (ua && ua !== DEFAULT_UA) params.set('ua', ua);
  return '/api/proxy?' + params.toString();
}

// Rewrite an m3u8 body: convert every absolute and relative segment/playlist
// URL into a proxy URL. Uses the provided base (origin + path) to resolve
// relative URLs.
function rewriteM3u8(body: string, baseOrigin: string, basePath: string, ua: string): string {
  const base = baseOrigin + basePath.substring(0, basePath.lastIndexOf('/') + 1);
  return body.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    let abs: string;
    try {
      abs = trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? new URL(trimmed).toString()
        : new URL(trimmed, base).toString();
    } catch {
      return line;
    }
    return proxyUrlFor(abs, ua);
  }).join('\n');
}

export const OPTIONS: APIRoute = async () => {
  // Handle CORS preflight requests from Safari/iOS and other browsers
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent',
      'Access-Control-Max-Age': '86400',
    },
  });
};

export const GET: APIRoute = async ({ url, request }) => {
  const target = url.searchParams.get('url');
  const hex = url.searchParams.get('hex');
  const ua = url.searchParams.get('ua') || DEFAULT_UA;
  // Build an absolute origin from the incoming request so the rewritten
  // manifest URLs are resolved against the deployed site (handles
  // http://localhost:4321 in dev and https://<site>.pages.dev in prod).
  const reqOrigin = new URL(request.url).origin;

  // Mode 1: decode hex m3u8 and serve as rewritten m3u8 manifest
  if (hex) {
    try {
      const m3u8 = Buffer.from(hex, 'hex').toString('utf-8');
      // Extract the base origin from the first absolute URL we can find
      // in the playlist. The akamai_m3u8_hex playlists always contain
      // absolute URLs to the Akamai CDN.
      const urlMatch = m3u8.match(/https?:\/\/[^\s"']+/);
      let baseOrigin: string;
      let basePath: string;
      if (urlMatch) {
        const u = new URL(urlMatch[0]);
        baseOrigin = u.origin;
        basePath = u.pathname;
      } else {
        // No absolute URLs found — fall back to the request origin
        baseOrigin = reqOrigin;
        basePath = '/';
      }
      const rewritten = rewriteM3u8(m3u8, baseOrigin, basePath, ua);
      const headers: Record<string, string> = {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Cache-Control': 'no-cache',
      };
      return new Response(rewritten, { status: 200, headers });
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-cache',
  };

  if (contentType.includes('mpegurl') || contentType.includes('m3u8') || target.endsWith('.m3u8')) {
    const body = await resp.text();
    return new Response(rewriteM3u8(body, remoteUrl.origin, remoteUrl.pathname, ua), { status: resp.status, headers });
  }

  return new Response(resp.body, { status: resp.status, headers });
};
