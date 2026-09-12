import type { APIRoute } from 'astro';

export const prerender = false;

const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const ALLOWED_UPSTREAM_PROTOCOLS = new Set(['http:', 'https:']);
const MEDIA_RESPONSE_HEADERS = [
  'Accept-Ranges',
  'Content-Range',
  'Content-Length',
  'ETag',
  'Last-Modified',
];

// Build a proxy URL for a given absolute remote URL and UA
function proxyUrlFor(remoteUrl: string, ua: string): string {
  const params = new URLSearchParams({ url: remoteUrl });
  if (ua && ua !== DEFAULT_UA) params.set('ua', ua);
  return '/api/proxy?' + params.toString();
}

function resolveHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(value, baseUrl);
    return ALLOWED_UPSTREAM_PROTOCOLS.has(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

// Rewrite both standalone playlist/segment lines and URI="..." attributes
// used by keys, init maps, alternate media, and iframe playlists.
export function rewriteM3u8(body: string, baseUrl: string, ua: string): string {
  return body.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return line.replace(/URI=(["'])(.*?)\1/gi, (attribute, quote: string, uri: string) => {
        const absoluteUrl = resolveHttpUrl(uri, baseUrl);
        return absoluteUrl ? `URI=${quote}${proxyUrlFor(absoluteUrl, ua)}${quote}` : attribute;
      });
    }

    const absoluteUrl = resolveHttpUrl(trimmed, baseUrl);
    return absoluteUrl ? proxyUrlFor(absoluteUrl, ua) : line;
  }).join('\n');
}

function decodeHex(value: string): string {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error('Invalid hex');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function allowedCorsOrigin(requestOrigin: string | null | undefined, requestUrl: string): string | null {
  if (!requestOrigin) return null;

  try {
    const origin = new URL(requestOrigin);
    const serviceOrigin = new URL(requestUrl).origin;

    // The player always calls the proxy on its own origin. Comparing against
    // the actual request URL also supports Pages previews and custom domains
    // without opening the endpoint to unrelated cross-origin websites.
    if (origin.origin === serviceOrigin) return origin.origin;

    // Keep local development working when the UI and Astro server use
    // different localhost ports.
    if (
      (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]')
      && (origin.protocol === 'http:' || origin.protocol === 'https:')
    ) {
      return origin.origin;
    }
  } catch {
    // Invalid Origin headers are not reflected.
  }

  return null;
}

function corsHeaders(contentType: string, requestOrigin: string | null | undefined, requestUrl: string): Headers {
  const origin = allowedCorsOrigin(requestOrigin, requestUrl);
  return new Headers({
    'Content-Type': contentType,
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Range, If-Range, User-Agent',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
    'Cache-Control': 'no-cache',
    'Vary': 'Origin',
  });
}

function upstreamResponseHeaders(resp: Response, contentType: string, copyContentLength: boolean, requestOrigin: string | null, requestUrl: string): Headers {
  const headers = corsHeaders(contentType, requestOrigin, requestUrl);
  for (const name of MEDIA_RESPONSE_HEADERS) {
    if (!copyContentLength && name === 'Content-Length') continue;
    const value = resp.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function jsonError(message: string, status: number, requestOrigin: string | null, requestUrl: string, upstreamStatus?: number): Response {
  return new Response(JSON.stringify({
    error: message,
    ...(upstreamStatus ? { upstreamStatus } : {}),
  }), {
    status,
    headers: corsHeaders('application/json; charset=utf-8', requestOrigin, requestUrl),
  });
}

export const OPTIONS: APIRoute = async ({ request }) => {
  const headers = corsHeaders('text/plain', request.headers.get('origin'), request.url);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, {
    status: 204,
    headers,
  });
};

const handleRequest: APIRoute = async ({ url, request }) => {
  const target = url.searchParams.get('url');
  const hex = url.searchParams.get('hex');
  const ua = url.searchParams.get('ua') || DEFAULT_UA;
  const reqOrigin = new URL(request.url).origin;
  const requestOrigin = request.headers.get('origin');
  const isHeadRequest = request.method === 'HEAD';

  // Mode 1: decode hex m3u8 and serve as rewritten m3u8 manifest
  if (hex) {
    try {
      const m3u8 = decodeHex(hex);
      if (!m3u8.trimStart().startsWith('#EXTM3U')) {
        return jsonError('Decoded content is not a valid HLS manifest', 400, requestOrigin, request.url);
      }
      const urlMatch = m3u8.match(/https?:\/\/[^\s"']+/);
      const baseUrl = urlMatch ? new URL(urlMatch[0]).toString() : `${reqOrigin}/`;
      const rewritten = rewriteM3u8(m3u8, baseUrl, ua);
      return new Response(isHeadRequest ? null : rewritten, {
        status: 200,
        headers: corsHeaders('application/vnd.apple.mpegurl', requestOrigin, request.url),
      });
    } catch {
      return jsonError('Invalid hex-encoded HLS manifest', 400, requestOrigin, request.url);
    }
  }

  // Mode 2: proxy a remote URL
  if (!target) {
    return jsonError('Missing url or hex param', 400, requestOrigin, request.url);
  }

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(target);
    if (!ALLOWED_UPSTREAM_PROTOCOLS.has(remoteUrl.protocol)) throw new Error('Unsupported protocol');
  } catch {
    return jsonError('Invalid or unsupported url', 400, requestOrigin, request.url);
  }

  const upstreamHeaders = new Headers({ 'User-Agent': ua });
  // Do not forward the website Origin to media CDNs. It is only relevant to
  // the browser-to-proxy CORS check and can cause upstream origin filtering.
  for (const name of ['Accept', 'Range', 'If-Range']) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }

  let resp: Response;
  try {
    resp = await fetch(remoteUrl.toString(), {
      method: isHeadRequest ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });
  } catch {
    return jsonError('Unable to reach the upstream stream', 502, requestOrigin, request.url);
  }

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const isManifest = contentType.toLowerCase().includes('mpegurl')
    || remoteUrl.pathname.toLowerCase().endsWith('.m3u8');

  if (!resp.ok) {
    const headers = upstreamResponseHeaders(resp, 'application/json; charset=utf-8', false, requestOrigin, request.url);
    return new Response(JSON.stringify({
      error: 'Upstream stream request failed',
      upstreamStatus: resp.status,
    }), { status: resp.status, headers });
  }

  if (isHeadRequest) {
    return new Response(null, {
      status: resp.status,
      headers: upstreamResponseHeaders(resp, contentType, true, requestOrigin, request.url),
    });
  }

  if (isManifest) {
    const body = await resp.text();
    if (!body.trimStart().startsWith('#EXTM3U')) {
      return jsonError('Upstream did not return a valid HLS manifest', 502, requestOrigin, request.url, resp.status);
    }
    return new Response(rewriteM3u8(body, remoteUrl.toString(), ua), {
      status: resp.status,
      headers: upstreamResponseHeaders(resp, 'application/vnd.apple.mpegurl', false, requestOrigin, request.url),
    });
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: upstreamResponseHeaders(resp, contentType, true, requestOrigin, request.url),
  });
};

export const GET = handleRequest;
export const HEAD = handleRequest;
