import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
let App;
beforeAll(async () => { ({ App } = await import('../src/App.jsx')); });
import { listConnections, saveConnection } from '../src/storage/connections.js';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const BASE_METHODS = ['rpc:discover', 'conversations:list', 'folders:list', 'conversations:create', 'models:list'];
const CONVERSATIONS = [{ id: 'thread-1', title: 'Existing', model: 'model:one', projectPath: 'C:\\Code\\avi' }];
const discoveryResult = () => ({ appVersion: '9.9.9', versions: { rpc: 1 }, methods: BASE_METHODS });

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  static responder = null;

  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocol = protocols?.[0] === 'avi-relay-v1' ? 'avi-relay-v1' : 'avi-rpc-v1';
    this.bufferedAmount = 0;
    this.handshake = null;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(value) {
    const request = JSON.parse(value);
    if (request.type === 'avi-remote-open') {
      this.handshake = request;
      this.url = `ws://local${request.path}`;
      queueMicrotask(() => {
        this.message({ type: 'avi-remote-ready', version: 2 });
        if (request.path.includes('/streams/')) this.message({ method: 'conversation:ready', params: {} });
      });
      return;
    }
    this.sent.push(request.method);
    queueMicrotask(async () => {
      try {
        const result = await (FakeSocket.responder ? FakeSocket.responder(this, request.method, request.params) : {});
        this.message({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        this.message({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } });
      }
    });
  }

  message(document) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(document) }));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = new Event('close');
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}

globalThis.WebSocket = FakeSocket;

function contextResult(socket) {
  const id = socket.url.split('/').at(-1) || 'thread-1';
  return {
    conversation: { id, title: 'Existing', model: 'model:one', projectPath: 'C:\\Code\\avi' },
    messages: [],
    messagePage: { cursor: null, hasMore: false },
    queue: { steer: [], queued: [] },
    run: { active: false, startedAt: null },
    approvals: [], questions: [], semaphoreWaits: [], tasks: [], sideChats: [], subagents: [], rubberDucks: [],
    composer: { permissionMode: 'approve_for_me', model: 'model:one', reasoningEffort: null, workMode: null, ultraMode: false, draftText: '', attachments: [] },
    contextUsage: { tokens: 100, limit: 1000 },
  };
}

function standardResponder(socket, method) {
  switch (method) {
    case 'rpc:discover': return socket.url.includes('/streams/') ? { versions: { rpc: 1 }, scope: 'conversation', methods: ['conversations:context', 'conversations:messages', 'composer-state:save', 'chat:send'] } : { ...discoveryResult(), scope: 'global' };
    case 'conversations:list': return CONVERSATIONS;
    case 'folders:list': return [];
    case 'conversations:create': return { conversation: { id: 'thread-2', title: 'Created', model: 'model:one' } };
    case 'conversations:context': return contextResult(socket);
    case 'conversations:messages': return { messages: [], messagePage: { cursor: null, hasMore: false } };
    case 'models:list': return { models: [{ id: 'model:one', name: 'One', reasoning: [] }], messageDeliveryMode: 'queue' };
    default: return {};
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const modelsRequested = () => FakeSocket.instances.reduce((count, socket) => count + socket.sent.filter((method) => method === 'models:list').length, 0);
const buttonByText = (text) => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text);

let root;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  FakeSocket.instances.length = 0;
  FakeSocket.responder = standardResponder;
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  act(() => render(null, root));
  document.body.replaceChildren();
  root = null;
});

async function renderApp() {
  act(() => render(h(App), root));
  for (let i = 0; i < 12; i += 1) await act(async () => { await flush(); });
}

async function openWorkspace() {
  act(() => buttonByText('Open workspace').click());
  for (let i = 0; i < 12; i += 1) await act(async () => { await flush(); });
}

describe('App connections and workspace lifecycle', () => {
  test('account approval lists relay devices before opening independent global and conversation consumers', async () => {
    const originalFetch = globalThis.fetch;
    const tickets = [];
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/auth/login')) return Response.json({ data: { accessToken: 'account-token' } });
      if (url.endsWith('/tickets')) {
        tickets.push(options);
        return Response.json({ ticket: 'a'.repeat(64), expiresAt: Date.now() + 60000, protocol: 'avi-relay-v1', websocketUrl: 'wss://avi-relay.projpw.workers.dev/v1/relays/11111111-1111-1111-1111-111111111111/laptop/connect' }, { status: 201 });
      }
      return Response.json({ avis: [{ deviceId: 'laptop', name: 'Laptop', connectedAt: 1, expiresAt: Date.now() + 60000, consumers: 0 }] });
    };
    try {
      await renderApp();
      await act(async () => { buttonByText('Login with AIVAX').click(); await flush(); });
      await act(async () => { const input = document.querySelector('[name="loginKey"]'); input.value = 'login-key'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
      await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush(); await flush(); });
      await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush(); await flush(); });
      await act(async () => { buttonByText('Open workspace').click(); await flush(); });
      for (let i = 0; i < 12; i++) await act(async () => { await flush(); });
      expect(document.querySelector('select[aria-label="Active Avi instance"]')).not.toBeNull();
      const global = FakeSocket.instances.find((socket) => socket.handshake?.path === '/rpc');
      expect(global.handshake).toEqual({ type: 'avi-remote-open', version: 2, path: '/rpc' });
      const thread = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Existing'));
      expect(thread).toBeDefined();
      await act(async () => { thread.click(); await flush(); });
      for (let i = 0; i < 12; i++) await act(async () => { await flush(); });
      const stream = FakeSocket.instances.find((socket) => socket.handshake?.path === '/rpc/conversations/streams/thread-1');
      expect(stream).toBeDefined();
      expect(stream).not.toBe(global);
      expect(stream.sent).toContain('conversations:context');
      expect(tickets).toHaveLength(2);
      expect(tickets.every((entry) => entry.headers.Authorization === 'Bearer account-token')).toBe(true);
      expect(await listConnections()).toEqual([]);
      await act(async () => { buttonByText('Connections').click(); await flush(); });
      expect(global.readyState).toBe(3);
      expect(stream.readyState).toBe(3);
    } finally { globalThis.fetch = originalFetch; }
  });
  test('probing performs only RPC discovery', async () => {
    await saveConnection({ label: 'Local', serverUrl: 'http://localhost:18991', apiKey: 'key-1' }, globalThis.indexedDB);
    await renderApp();
    expect(document.querySelector('.connection-status.online')).not.toBeNull();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].sent).toEqual(['rpc:discover']);
    expect(FakeSocket.instances[0].readyState).toBe(3);
  });

  test('opening a workspace loads the model catalog exactly once and selects the connection', async () => {
    const saved = await saveConnection({ label: 'Local', serverUrl: 'http://localhost:18991', apiKey: 'key-1' }, globalThis.indexedDB);
    await renderApp();
    await openWorkspace();
    const select = document.querySelector('select[aria-label="Active Avi instance"]');
    expect(select).not.toBeNull();
    expect(select.value).toBe(saved.id);
    expect(select.disabled).toBe(false);
    expect(modelsRequested()).toBe(1);
  });

  test('opening shows busy feedback until the workspace is ready', async () => {
    await saveConnection({ label: 'Local', serverUrl: 'http://localhost:18991', apiKey: 'key-1' }, globalThis.indexedDB);
    const hold = deferred();
    let discovers = 0;
    FakeSocket.responder = (socket, method) => {
      if (method === 'rpc:discover' && (discovers += 1) >= 2) return hold.promise;
      return standardResponder(socket, method);
    };
    await renderApp();
    await act(async () => { buttonByText('Open workspace').click(); await flush(); });
    const openButton = buttonByText('Opening...');
    expect(openButton).not.toBeNull();
    expect(openButton.disabled).toBe(true);
    await act(async () => { hold.resolve(discoveryResult()); await flush(); await flush(); });
    expect(document.querySelector('select[aria-label="Active Avi instance"]')).not.toBeNull();
    expect(modelsRequested()).toBe(1);
  });

  test('workspace refreshes do not reload the model catalog', async () => {
    await saveConnection({ label: 'Local', serverUrl: 'http://localhost:18991', apiKey: 'key-1' }, globalThis.indexedDB);
    await renderApp();
    await openWorkspace();
    const newChat = document.querySelector('.folder-new-chat');
    expect(newChat).not.toBeNull();
    await act(async () => { newChat.click(); await flush(); await flush(); });
    expect(modelsRequested()).toBe(1);
    expect(FakeSocket.instances.some((socket) => socket.sent.includes('conversations:create'))).toBe(true);
  });

  test('exiting during an in-flight refresh leaves the workspace closed', async () => {
    await saveConnection({ label: 'Local', serverUrl: 'http://localhost:18991', apiKey: 'key-1' }, globalThis.indexedDB);
    const hold = deferred();
    let folders = 0;
    FakeSocket.responder = (socket, method) => {
      if (method === 'folders:list' && (folders += 1) >= 2) return hold.promise;
      return standardResponder(socket, method);
    };
    await renderApp();
    await openWorkspace();
    await act(async () => { document.querySelector('.folder-new-chat').click(); await flush(); });
    await act(async () => { buttonByText('Connections').click(); await flush(); });
    hold.resolve([]);
    await act(async () => { await flush(); await flush(); });
    expect(document.querySelector('.connections-page')).not.toBeNull();
    expect(document.querySelector('select[aria-label="Active Avi instance"]')).toBeNull();
  });

  test('the latest connect wins and the obsolete attempt is closed', async () => {
    const beta = await saveConnection({ label: 'Beta', serverUrl: 'http://localhost:18992', apiKey: 'key-2' }, globalThis.indexedDB);
    await saveConnection({ label: 'Alpha', serverUrl: 'http://localhost:18991', apiKey: 'key-1' }, globalThis.indexedDB);
    const hold = deferred();
    FakeSocket.responder = (socket, method) => {
      if (method === 'rpc:discover' && socket.url.includes('18991')) {
        const [, second] = FakeSocket.instances.filter((item) => item.url.includes('18991'));
        if (socket === second) return hold.promise;
      }
      return standardResponder(socket, method);
    };
    await renderApp();
    const alphaButton = buttonByText('Open workspace');
    const betaButton = [...document.querySelectorAll('article.connection-card')]
      .find((card) => card.textContent.includes('Beta'))
      .querySelector('footer button.primary');
    await act(async () => {
      alphaButton.click();
      betaButton.click();
      await flush(); await flush();
    });
    hold.resolve(discoveryResult());
    await act(async () => { await flush(); await flush(); });
    const select = document.querySelector('select[aria-label="Active Avi instance"]');
    expect(select).not.toBeNull();
    expect(select.value).toBe(beta.id);
    for (const socket of FakeSocket.instances.filter((item) => item.url.includes('18991'))) {
      expect(socket.readyState).toBe(3);
    }
    expect(modelsRequested()).toBe(1);
  });
});
