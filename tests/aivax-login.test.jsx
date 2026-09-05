import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { IDBFactory } from 'fake-indexeddb';
import { ConnectionsPage } from '../src/components/ConnectionsPage.jsx';
import { loadAivaxAccessToken, saveAivaxAccessToken } from '../src/storage/connections.js';
import { AIVAX_LOGIN_URL, AIVAX_RELAYS_URL } from '../src/rpc/aivax.js';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout });
const originalFetch = globalThis.fetch;
const root = document.createElement('div');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  act(() => render(null, root));
  root.remove();
  globalThis.fetch = originalFetch;
});

for (const rejected of [false, true]) {
  test(`AIVAX login ${rejected ? 'rejects invalid credentials safely' : 'lists devices and logs out'}`, async () => {
    globalThis.indexedDB = new IDBFactory();
    document.body.append(root);
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(url === AIVAX_LOGIN_URL
        ? rejected ? { message: 'secret server error' } : { data: { accessToken: 'session-token' } }
        : { avis: [{ deviceId: 'laptop', name: '<img src=x onerror=alert(1)>', connectedAt: 1, expiresAt: 2, consumers: 0 }, { deviceId: 'desktop', name: 'Desktop', connectedAt: 1, expiresAt: 2, consumers: 0 }] }), { status: rejected ? 401 : 200 });
    };
    await act(async () => { render(h(ConnectionsPage, { statuses: {}, onCheck: () => {}, onEnter: () => {} }), root); await flush(); });
    await act(async () => { [...root.querySelectorAll('button')].find((button) => button.textContent.includes('Login with AIVAX')).click(); });
    const input = root.querySelector('[name="loginKey"]');
    await act(async () => { input.value = 'login-secret'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await act(async () => { root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush(); });
    expect(calls[0].url).toBe(AIVAX_LOGIN_URL);
    expect(JSON.parse(calls[0].options.body)).toEqual({ loginKey: 'login-secret' });
    expect(calls[0].options.credentials).toBe('omit');
    expect(calls[0].options.redirect).toBe('error');
    if (rejected) {
      expect(calls).toHaveLength(1);
      expect(root.querySelector('[role="alert"]').textContent).toContain('Authentication rejected');
      expect(root.textContent).not.toContain('secret server error');
    } else {
      expect(calls[1].url).toBe(AIVAX_RELAYS_URL);
      expect(calls[1].options.headers.Authorization).toBe('Bearer session-token');
      expect(root.querySelector('.aivax-devices').textContent).toContain('<img');
      expect(root.querySelector('.aivax-devices img')).toBeNull();
      expect(root.querySelector('[name="loginKey"]')).toBeNull();
      expect(root.querySelector('.aivax-devices button')).toBeNull();
      expect(await loadAivaxAccessToken()).toBe('');
      await act(async () => { root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush(); await flush(); });
      expect(root.querySelector('[role="dialog"]')).toBeNull();
      expect(root.querySelectorAll('.connection-card')).toHaveLength(2);
      expect(await loadAivaxAccessToken()).toBe('session-token');
      await act(async () => { render(null, root); });
      calls.length = 0;
      await act(async () => { render(h(ConnectionsPage, { statuses: {}, onCheck: () => {}, onEnter: () => {} }), root); await flush(); await flush(); await flush(); });
      for (let i = 0; i < 12; i++) await act(async () => { await flush(); });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(AIVAX_RELAYS_URL);
      expect(calls[0].options.headers.Authorization).toBe('Bearer session-token');
      expect(root.querySelectorAll('.connection-card')).toHaveLength(2);
      await act(async () => { [...root.querySelectorAll('button')].find((button) => button.textContent.includes('AIVAX account')).click(); });
      await act(async () => { [...root.querySelectorAll('button')].find((button) => button.textContent === 'Log out').click(); await flush(); await flush(); });
      expect(await loadAivaxAccessToken()).toBe('');
      expect(root.querySelectorAll('.connection-card')).toHaveLength(0);
      expect(root.querySelector('[name="loginKey"]').value).toBe('');
      expect(root.querySelector('.aivax-devices')).toBeNull();
    }
  });
}

for (const status of [401, 503]) {
  test(`saved account handles HTTP ${status} without requesting a login exchange`, async () => {
    globalThis.indexedDB = new IDBFactory();
    await saveAivaxAccessToken('saved-token');
    document.body.append(root);
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(url); return Response.json({}, { status }); };
    await act(async () => { render(h(ConnectionsPage, { statuses: {}, onCheck: () => {}, onEnter: () => {} }), root); });
    for (let i = 0; i < 12; i++) await act(async () => { await flush(); });
    expect(calls).toEqual([AIVAX_RELAYS_URL]);
    expect(await loadAivaxAccessToken()).toBe(status === 401 ? '' : 'saved-token');
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.querySelectorAll('.connection-card')).toHaveLength(0);
  });
}
