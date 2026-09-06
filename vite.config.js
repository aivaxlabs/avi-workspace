import { defineConfig } from 'vite';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import preact from '@preact/preset-vite';

// Vite 7 and esbuild disagree on Windows junction paths; remove when Vite handles linked working directories.
process.chdir(realpathSync.native(process.cwd()));

const buildId = randomBytes(6).toString('hex');

export default defineConfig({
  base: './',
  plugins: [
    preact(),
    {
      name: 'pwa-shell',
      apply: 'build',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const publicAssets = ['avi.png', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
        const assets = [...Object.keys(bundle).filter((name) => !name.endsWith('.map')), ...publicAssets];
        const hash = createHash('sha256');
        for (const name of Object.keys(bundle).sort()) hash.update(bundle[name].code ?? bundle[name].source);
        for (const name of publicAssets) hash.update(readFileSync(new URL(`./public/${name}`, import.meta.url)));
        const template = readFileSync(new URL('./src/service-worker.js', import.meta.url), 'utf8');
        hash.update(template);
        const source = template.replace('__PRECACHE_ASSETS__', JSON.stringify(assets)).replace('__PRECACHE_NAME__', '`avi-shell:${new URL(self.registration.scope).pathname}:' + hash.digest('hex').slice(0, 16) + '`');
        this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      },
    },
    {
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';"),
    },
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${buildId}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildId}.js`,
        assetFileNames: `assets/[name]-[hash]-${buildId}[extname]`,
      },
    },
  },
});
