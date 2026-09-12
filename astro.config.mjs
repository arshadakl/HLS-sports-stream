import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://REPLACE-WITH-YOUR-PROJECT.pages.dev',
  output: 'hybrid',
  adapter: node({ mode: 'standalone' }),
  integrations: [tailwind()],
  vite: {
    server: {
      allowedHosts: true,
    },
  },
});
