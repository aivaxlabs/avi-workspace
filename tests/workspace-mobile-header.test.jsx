import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { FakeSocket as OrpcSocket } from './orpc-test-helpers.js';

const window = new Window({ url: 'http://localhost/' });
window.matchMedia = () => ({
  matches: true,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
});

class FakeSocket extends OrpcSocket {
  constructor() {
    super(undefined, undefined);
    this.requests = [];
    this.methods = ['conversations:context', 'composer-state:save', 'chat:send', 'conversations:tool-call-details'];
    queueMicrotask(() => {
      this.message({ jsonrpc: '2.0', method: 'conversation:ready', params: { sequence: 0, conversationId: 'thread-1' } });
    });
  }

  respond(socket, request) {
    this.requests.push(request);
    if (request.method === 'conversations:tool-call-details') { this.message({ id: request.id, result: { argumentsText: '{"path":"demo.js"}', resultText: 'Actual tool output', hasResult: true } }); return; }
    if (request.method === 'rpc:discover') { this.message({ id: request.id, result: { versions: { rpc: 1 }, scope: 'conversation', methods: this.methods } }); return; }
    if (request.method === 'conversations:context') {
      this.message({
        id: request.id,
        result: {
          conversation: { id: 'thread-1', title: 'Mobile thread', model: 'model:one', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi' },
          messages: [{ id: 'user-1', role: 'user', content: 'Mobile request' }, { id: 'assistant-1', role: 'assistant', segments: [{ id: 'tool-1', messageId: 'assistant-1', type: 'tool-call', name: 'read_file', detailsAvailable: true, hasResult: true }] }],
          messagePage: { cursor: null, hasMore: false },
          queue: { steer: [], queued: [] },
          run: { active: false, startedAt: null },
          approvals: [],
          questions: [],
          semaphoreWaits: [],
          tasks: [],
          sideChats: [],
          subagents: [],
          rubberDucks: [],
          composer: { permissionMode: 'approve_for_me', model: 'model:one', reasoningEffort: null, workMode: null, ultraMode: false, draftText: '', attachments: [] },
          contextUsage: { tokens: 100, limit: 1000 },
        },
      });
    } else if (request.id) {
      this.message({ id: request.id, result: true });
    }
  }
}

globalThis.WebSocket = FakeSocket;

let WorkspacePage;
let root;

beforeAll(async () => {
  ({ WorkspacePage } = await import('../src/components/WorkspacePage.jsx'));
});

afterEach(() => {
  if (root) act(() => render(null, root));
  document.body.replaceChildren();
  document.body.style.overflow = '';
  FakeSocket.instances.length = 0;
  root = null;
});

describe('workspace mobile shell', () => {
  test('uses conversation discovery for tool details and refreshes capabilities on ready', async () => {
    root = document.createElement('div');
    document.body.append(root);
    act(() => render(h(WorkspacePage, {
      connection: { id: 'scope', label: 'Scoped Avi', serverUrl: 'http://localhost:18992', apiKey: 'synthetic' },
      globalClient: { request: () => Promise.resolve() },
      discovery: { versions: { rpc: 1 }, methods: ['conversations:list'] },
      conversations: [{ id: 'thread-1', title: 'Scoped thread' }], models: [], folders: [], onRefresh: async () => {}, onExit() {},
    }), root));
    await act(async () => {
      const started = Date.now();
      while (!root.querySelector('.thinking-summary') && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    act(() => root.querySelector('.thinking-summary').click());
    act(() => root.querySelector('.tool-line').click());
    await act(async () => {
      const started = Date.now();
      while (!root.textContent.includes('Actual tool output') && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(root.textContent).toContain('Actual tool output');
    expect(root.textContent).not.toContain('Tool details are not available');
    const socket = FakeSocket.instances.at(-1);
    expect(socket.requests.some((request) => request.method === 'conversations:tool-call-details')).toBe(true);
    socket.methods = ['conversations:context'];
    act(() => socket.message({ jsonrpc: '2.0', method: 'conversation:ready', params: { sequence: 0, conversationId: 'thread-1' } }));
    await act(async () => {
      const started = Date.now();
      while (socket.requests.filter((request) => request.method === 'rpc:discover').length < 2 && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(socket.requests.filter((request) => request.method === 'rpc:discover')).toHaveLength(2);
    expect(root.textContent).toContain('Tool details are not available');
  });

  test('resizes desktop panels by keyboard and pointer with in-memory widths', async () => {
    const previousMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const memory = new Map();
    try {
      root = document.createElement('div'); document.body.append(root);
      act(() => render(h(WorkspacePage, {
        connection: { id: 'desktop', label: 'Desktop Avi', serverUrl: 'http://localhost:18992', apiKey: 'synthetic' },
        workspaceMemory: memory, globalClient: { request: () => Promise.resolve() }, discovery: { versions: { rpc: 1 }, methods: [] },
        conversations: [{ id: 'thread-1', title: 'Desktop thread' }], models: [], folders: [], onRefresh: async () => {}, onExit() {},
      }), root));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
      const sidebar = root.querySelector('[aria-label="Resize sidebar"]');
      expect(sidebar.getAttribute('aria-valuenow')).toBe('222');
      act(() => sidebar.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      expect(sidebar.getAttribute('aria-valuenow')).toBe('232');
      sidebar.setPointerCapture = () => {};
      sidebar.hasPointerCapture = () => false;
      act(() => sidebar.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, clientX: 232, pointerId: 1, bubbles: true })));
      act(() => sidebar.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 252, pointerId: 1, bubbles: true })));
      act(() => sidebar.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 1, bubbles: true })));
      expect(sidebar.getAttribute('aria-valuenow')).toBe('252');
      act(() => root.querySelector('[aria-label="Open auxiliary panel"]').click());
      const panel = root.querySelector('[aria-label="Resize auxiliary panel"]');
      expect(panel).not.toBeNull();
      act(() => panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
      expect(panel.getAttribute('aria-valuenow')).toBe('280');
      expect(memory.get('desktop').widths).toEqual({ sidebar: 252, panel: 280 });
      act(() => root.querySelector('[aria-label="Close auxiliary panel"]').click());
      expect(root.querySelector('[aria-label="Resize auxiliary panel"]')).toBeNull();
    } finally { window.matchMedia = previousMatchMedia; }
  });
  test('switches instances and restores the remembered conversation without persisting remote state', async () => {
    root = document.createElement('div');
    document.body.append(root);
    const first = { id: 'first', label: 'Development', serverUrl: 'http://localhost:18991', apiKey: 'synthetic' };
    const second = { id: 'second', label: 'Production', serverUrl: 'http://localhost:18992', apiKey: 'synthetic' };
    const memory = new Map([['first', { selectedId: 'thread-2', drafts: new Map() }]]);
    const switches = [];
    act(() => render(h(WorkspacePage, {
      connection: first, connections: [first, second], workspaceMemory: memory,
      onSwitchConnection: (item) => switches.push(item),
      connectionStatus: { status: 'offline', error: 'Network disconnected' },
      globalClient: { request: () => Promise.resolve() },
      discovery: { appVersion: 'test', apiVersion: 1, versions: { core: 2, mcp: { latest: 1 } }, methods: [] },
      models: [], conversations: [{ id: 'thread-1', title: 'First' }, { id: 'thread-2', title: 'Second' }], folders: [],
      onRefresh: async () => {}, onExit() {},
    }), root));
    const selector = root.querySelector('[aria-label="Active Avi instance"]');
    expect(selector.value).toBe('first');
    expect(root.querySelector('.workspace-connection-alert').textContent).toContain('Network disconnected');
    expect(root.querySelector('.thread-list li.active .thread-open').textContent).toContain('Second');
    expect(root.querySelector('.auxiliary-panel')).toBeNull();
    act(() => { selector.value = 'second'; selector.dispatchEvent(new window.Event('change', { bubbles: true })); });
    expect(switches).toEqual([second]);
    expect(memory.get('first').selectedId).toBe('thread-2');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  });

  test('opens immersive navigation and panel dialogs and exposes permission in the Plus menu', async () => {
    root = document.createElement('div');
    document.body.append(root);
    act(() => render(h(WorkspacePage, {
      connection: { id: 'connection-1', label: 'Test Avi', serverUrl: 'http://localhost:18991', apiKey: 'synthetic' },
      globalClient: { request: () => Promise.resolve() },
      discovery: { appVersion: 'test', apiVersion: 1, versions: { core: 2, mcp: { latest: 1 } } },
      models: [{ id: 'model:one', name: 'Model One', reasoning: [] }],
      conversations: [{ id: 'thread-1', title: 'Mobile thread', model: 'model:one', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi' }],
      folders: [{ path: 'C:\\Code\\avi', name: 'avi', displayPath: 'C:\\Code\\avi' }],
      onRefresh() {},
      onExit() {},
    }), root));

    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

    const header = root.querySelector('.mobile-header');
    act(() => FakeSocket.instances.at(-1).message({ jsonrpc: '2.0', method: 'conversation:event', params: { sequence: 1, event: { type: 'error', message: 'Remote run failed' } } }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(root.querySelector('.workspace-connection-alert').textContent).toContain('Remote run failed');
    act(() => root.querySelector('[aria-label="Dismiss error"]').click());
    expect(root.querySelector('.workspace-connection-alert')).toBeNull();
    expect(header.querySelector('.instance-bar')).toBeNull();
    expect(root.querySelector('.sidebar .instance-bar').textContent).toContain('Test Avi');
    expect(root.querySelector('[role="separator"]')).toBeNull();
    expect(header.textContent).toContain('Mobile thread');
    expect(header.textContent).toContain('avi');
    expect(root.querySelector('.auxiliary-panel')).toBeNull();

    act(() => root.querySelector('[aria-label="Open navigation"]').click());
    expect(root.querySelector('.mobile-drawer[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    expect(root.querySelector('.chat-area').hasAttribute('inert')).toBe(true);
    const drawerButtons = root.querySelectorAll('.mobile-drawer button:not([disabled])');
    drawerButtons[drawerButtons.length - 1].focus();
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(drawerButtons[0]);
    act(() => root.querySelector('.mobile-drawer .thread-open').click());
    expect(root.querySelector('.mobile-drawer')).toBeNull();
    expect(root.querySelector('.chat-area').hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('[aria-label="Open navigation"]'));

    act(() => root.querySelector('[aria-label="Open auxiliary panel"]').click());
    expect(root.querySelector('.auxiliary-panel[role="dialog"][aria-modal="true"]')).not.toBeNull();
    act(() => root.querySelector('.auxiliary-panel .close-panel').click());
    expect(root.querySelector('.auxiliary-panel')).toBeNull();

    act(() => root.querySelector('[aria-label="Composer actions"]').click());
    const permissionOptions = root.querySelectorAll('.mobile-permission-options [role="menuitemradio"]');
    expect(permissionOptions).toHaveLength(3);
    expect([...permissionOptions].map((button) => button.textContent)).toEqual([
      'Ask for approvalAsk before every tool call',
      'Approve for meAsk only before destructive actions',
      'Full accessRun tool calls without approval',
    ]);
  });
});
