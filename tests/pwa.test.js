import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const template = readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8');

function worker({ cachedResponse, networkResponse, offline = false } = {}) {
  const handlers = {};
  const cached = [];
  const deleted = [];
  const requests = [];
  const lifecycle = [];
  const cache = { addAll: async (urls) => cached.push(...urls), match: async (key) => cachedResponse === undefined ? `cached:${key}` : cachedResponse };
  runInNewContext(template.replace('__PRECACHE_ASSETS__', '["index.html","assets/app.js"]').replace('__PRECACHE_NAME__', '"avi-shell:/workspace/:new"'), {
    URL, Set, Promise, Response,
    self: { registration: { scope: 'https://example.test/workspace/' }, skipWaiting: async () => lifecycle.push('skipWaiting'), clients: { claim: async () => lifecycle.push('claim') }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { open: async () => cache, keys: async () => ['avi-shell:/workspace/:old', 'avi-shell:/workspace/:new', 'other-app'], delete: async (key) => deleted.push(key) },
    fetch: async (request, options) => {
      requests.push({ request, options });
      if (offline) throw new Error('Offline');
      return networkResponse ?? 'network';
    },
  });
  return { handlers, cached, deleted, requests, lifecycle };
}

describe('PWA shell', () => {
  test('precaches only explicit assets and cleans only its own older caches', async () => {
    const view = worker();
    let pending;
    view.handlers.install({ waitUntil: (promise) => { pending = promise; } });
    await pending;
    expect(view.cached).toEqual(['https://example.test/workspace/', 'https://example.test/workspace/assets/app.js']);
    expect(view.lifecycle).toEqual(['skipWaiting']);
    view.handlers.activate({ waitUntil: (promise) => { pending = promise; } });
    await pending;
    expect(view.deleted).toEqual(['avi-shell:/workspace/:old']);
    expect(view.lifecycle).toEqual(['skipWaiting', 'claim']);
  });

  test('fetches fresh HTML on navigation and falls back to the offline shell', async () => {
    const request = { method: 'GET', mode: 'navigate', url: 'https://example.test/workspace/' };
    const online = worker();
    let response;
    online.handlers.fetch({ request, respondWith: (promise) => { response = promise; } });
    expect(await response).toBe('network');
    expect(online.requests).toEqual([{ request, options: { cache: 'no-store' } }]);

    const offline = worker({ offline: true });
    offline.handlers.fetch({ request, respondWith: (promise) => { response = promise; } });
    expect(await response).toBe('cached:https://example.test/workspace/');
  });

  test('ignores RPC, foreign requests and arbitrary files', async () => {
    const view = worker();
    for (const url of ['https://example.test/rpc', 'https://remote.test/attachment', 'https://example.test/workspace/private.json']) {
      let intercepted = false;
      view.handlers.fetch({ request: { method: 'GET', mode: 'cors', url }, respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });

  test('serves canonical cached HTML for offline index.html navigation too', async () => {
    const view = worker({ offline: true });
    let response;
    view.handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://example.test/workspace/index.html' }, respondWith: (promise) => { response = promise; } });
    expect(await response).toBe('cached:https://example.test/workspace/');
  });

  for (const source of ['cache', 'network']) {
    test(`removes redirect metadata from ${source} navigation responses without losing HTML or headers`, async () => {
      const redirected = new Response('<!doctype html><title>Avi</title>', { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'" } });
      Object.defineProperty(redirected, 'redirected', { value: true });
      const view = worker(source === 'cache' ? { cachedResponse: redirected, offline: true } : { networkResponse: redirected });
      let pending;
      view.handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://example.test/workspace/' }, respondWith: (promise) => { pending = promise; } });
      const response = await pending;
      expect(response.redirected).toBe(false);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
      expect(await response.text()).toBe('<!doctype html><title>Avi</title>');
    });
  }

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
