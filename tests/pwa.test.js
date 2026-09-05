import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const template = readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8');

function worker() {
  const handlers = {};
  const cached = [];
  const deleted = [];
  const cache = { addAll: async (urls) => cached.push(...urls), match: async (key) => `cached:${key}` };
  runInNewContext(template.replace('__PRECACHE_ASSETS__', '["index.html","assets/app.js"]').replace('__PRECACHE_NAME__', '"avi-shell:/workspace/:new"'), {
    URL, Set, Promise,
    self: { registration: { scope: 'https://example.test/workspace/' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { open: async () => cache, keys: async () => ['avi-shell:/workspace/:old', 'avi-shell:/workspace/:new', 'other-app'], delete: async (key) => deleted.push(key) },
    fetch: async () => 'network',
  });
  return { handlers, cached, deleted };
}

describe('PWA shell', () => {
  test('precaches only explicit assets and cleans only its own older caches', async () => {
    const view = worker();
    let pending;
    view.handlers.install({ waitUntil: (promise) => { pending = promise; } });
    await pending;
    expect(view.cached).toEqual(['https://example.test/workspace/index.html', 'https://example.test/workspace/assets/app.js']);
    view.handlers.activate({ waitUntil: (promise) => { pending = promise; } });
    await pending;
    expect(view.deleted).toEqual(['avi-shell:/workspace/:old']);
    expect(template).not.toContain('skipWaiting');
  });

  test('serves the offline shell but ignores RPC, foreign requests and arbitrary files', async () => {
    const view = worker();
    let response;
    view.handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://example.test/workspace/' }, respondWith: (promise) => { response = promise; } });
    expect(await response).toBe('cached:https://example.test/workspace/index.html');
    for (const url of ['https://example.test/rpc', 'https://remote.test/attachment', 'https://example.test/workspace/private.json']) {
      let intercepted = false;
      view.handlers.fetch({ request: { method: 'GET', mode: 'cors', url }, respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });

  test('manifest has stable relative identity and valid PNG icon dimensions', () => {
    const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
    expect(manifest.id).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons) {
      const bytes = readFileSync(new URL(`../public/${icon.src}`, import.meta.url));
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });
});
