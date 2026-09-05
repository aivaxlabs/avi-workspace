import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { ConnectionsPage } from '../src/components/ConnectionsPage.jsx';
import { listConnections } from '../src/storage/connections.js';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
});

function putRawConnection(record, indexedDB) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('avi-workspace-connections', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('connections', { keyPath: 'id' });
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('connections', 'readwrite');
      transaction.objectStore('connections').put(record);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not seed legacy connection.'));
    };
    open.onerror = () => reject(open.error);
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let root;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  act(() => render(null, root));
  document.body.replaceChildren();
  root = null;
});

describe('ConnectionsPage', () => {
  test('opens touch forms without focusing a keyboard field and keeps input hints', async () => {
    const original = window.matchMedia;
    window.matchMedia = (query) => ({ matches: query === '(pointer: coarse)' });
    try {
      await act(async () => {
        render(h(ConnectionsPage, { statuses: {}, onCheck() {}, onEnter() {} }), root);
        await flush();
      });
      const opener = root.querySelector('.connection-actions button');
      opener.focus();
      await act(async () => { opener.click(); await flush(); });
      await act(async () => { await flush(); });
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
      expect(root.querySelector('[autofocus]')).toBeNull();
      const url = root.querySelector('[name="serverUrl"]');
      expect(url.type).toBe('url');
      expect(url.getAttribute('inputmode')).toBe('url');
      expect(url.getAttribute('autocapitalize')).toBe('none');
      expect(root.querySelector('[name="apiKey"]').getAttribute('enterkeyhint')).toBe('go');
      await act(async () => { root.querySelector('[aria-label="Close"]').click(); await flush(); });
      expect(document.activeElement === opener).toBe(true);
    } finally { window.matchMedia = original; }
  });

  test('saving an edit reprobes the record and migrates a legacy empty id', async () => {
    await putRawConnection({ id: '', label: 'Legacy', serverUrl: 'http://localhost:18992', apiKey: 'old-key', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' }, globalThis.indexedDB);
    const checks = [];
    await act(async () => {
      render(h(ConnectionsPage, { statuses: {}, openingId: null, onCheck: (connection) => checks.push(connection), onEnter: () => {} }), root);
      await flush(); await flush();
    });
    for (let i = 0; i < 12; i += 1) await act(async () => { await flush(); });
    expect(checks).toHaveLength(1);
    await act(async () => {
      [...document.querySelectorAll('button[aria-label^="Edit"]')][0].click();
      await flush();
    });
    const nameInput = document.querySelector('.connection-dialog label input');
    act(() => {
      nameInput.value = 'Renamed';
      nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...document.querySelectorAll('.connection-dialog button')]
        .find((button) => button.textContent.trim() === 'Save connection')
        .click();
      await flush(); await flush();
    });
    expect(document.querySelector('.connection-dialog')).toBeNull();
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const reprobed = checks.at(-1);
    expect(reprobed.label).toBe('Renamed');
    expect(reprobed.id).not.toBe('');
    expect(reprobed.createdAt).toBe('2024-01-01T00:00:00.000Z');
    const stored = await listConnections(globalThis.indexedDB);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(reprobed.id);
    expect(stored[0].apiKey).toBe('old-key');
  });
});
