import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: './',
  plugins: [
    preact(),
    {
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';"),
    },
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
