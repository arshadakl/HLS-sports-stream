import type { APIRoute } from 'astro';

export const prerender = false;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export const GET: APIRoute = async ({ url }) => {
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response(JSON.stringify({ error: 'Missing url param' }), { status: 400 });
  }

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid url' }), { status: 400 });
  }

  const resp = await fetch(remoteUrl.toString(), {
    headers: { 'User-Agent': UA },
  });

  const contentType = resp.headers.get('content-type') || 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  if (contentType.includes('mpegurl') || contentType.includes('m3u8') || target.endsWith('.m3u8')) {
    let body = await resp.text();
    const base = remoteUrl.origin + remoteUrl.pathname.substring(0, remoteUrl.pathname.lastIndexOf('/') + 1);
    const lines = body.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      let abs: string;
      try { abs = new URL(trimmed, base).toString(); } catch { return line; }
      return `/api/proxy?url=${encodeURIComponent(abs)}`;
    });
    return new Response(lines.join('\n'), { status: resp.status, headers });
  }

  return new Response(resp.body, { status: resp.status, headers });
};
