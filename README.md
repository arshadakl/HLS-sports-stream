# HLS Sports Stream

A modern live sports streaming site built with **Astro + Tailwind CSS** that aggregates and plays HLS streams from remote CDNs through a server-side CORS proxy.

## Features

- Live and Upcoming match tabs
- HLS playback via hls.js with native fallback (Safari)
- Server-side proxy that injects the required `User-Agent` header and rewrites `.m3u8` segment URLs to bypass CORS
- Glassmorphism header and card design
- Responsive grid (3 / 2 / 1 columns)
- Real-time manifest loading from a remote JSON source

## Run locally

```bash
npm install
npm run dev      # http://localhost:4321
```

## Build

```bash
npm run build    # outputs to dist/ (hybrid: static + SSR for /api/proxy)
npm run preview
```

## Tech stack

- [Astro](https://astro.build/) — hybrid static + SSR
- [Tailwind CSS](https://tailwindcss.com/) — utility-first styling
- [hls.js](https://github.com/video-dev/hls.js/) — HLS playback
- [@astrojs/node](https://docs.astro.build/en/guides/integrations-guide/node/) — SSR adapter

## Project structure

```
src/
  pages/
    index.astro          # Main page
    api/
      proxy.ts           # CORS proxy for HLS streams
public/
  demo-player.js         # Client-side HLS player + tabs
  streams.json           # Local fallback manifest
astro.config.mjs         # Astro + hybrid + tailwind config
tailwind.config.mjs      # Tailwind theme tokens
```

## Deploy

The site is a hybrid Astro app (static page + SSR API route). Deploy to any Node host:

1. Push to a Git repo
2. Build command: `npm run build`
3. Start command: `node dist/server/entry.mjs`

For Cloudflare Pages / Vercel / Netlify, swap the `@astrojs/node` adapter for the appropriate one.
