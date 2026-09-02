import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';

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

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];

  constructor() {
    super();
    this.protocol = 'avi-rpc-v1';
    this.readyState = 0;
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event('open'));
      this.message({ jsonrpc: '2.0', method: 'conversation:ready', params: { sequence: 0, conversationId: 'thread-1' } });
    });
  }

  send(value) {
    const request = JSON.parse(value);
    if (request.method !== 'conversations:context') return;
    queueMicrotask(() => this.message({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        conversation: { id: 'thread-1', title: 'Scroll test', model: 'model:one', projectPath: 'C:\\Code\\avi' },
        messages: [
          { id: 'user-1', role: 'user', content: 'Earlier request' },
          { id: 'assistant-1', role: 'assistant', content: 'Earlier answer' },
          { id: 'user-2', role: 'user', content: 'Latest request' },
          { id: 'assistant-2', role: 'assistant', content: 'Latest answer' },
        ],
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
    }));
  }

  message(document) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(document) }));
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    const event = new Event('close');
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
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
  FakeSocket.instances.length = 0;
  root = null;
});

describe('workspace initial scroll', () => {
  test('matches the scroll clearance to the Composer height', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverStub {
      constructor(callback) { this.callback = callback; }
      observe(target) { this.callback([{ target, borderBoxSize: [{ blockSize: 312 }], contentRect: { height: 0 } }]); }
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;

    try {
      root = document.createElement('div');
      document.body.append(root);
      act(() => render(h(WorkspacePage, {
        connection: { id: 'connection-1', label: 'Test Avi', serverUrl: 'http://localhost:18991', apiKey: 'synthetic' },
        globalClient: { request: () => Promise.resolve() },
        discovery: { appVersion: 'test', apiVersion: 1, versions: { core: 2, mcp: { latest: 1 } } },
        models: [{ id: 'model:one', name: 'Model One', reasoning: [] }],
        conversations: [{ id: 'thread-1', title: 'Scroll test', model: 'model:one', projectPath: 'C:\\Code\\avi' }],
        folders: [],
        onRefresh() {},
        onExit() {},
      }), root));

      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

      expect(root.querySelector('.chat-area').style.getPropertyValue('--composer-clearance')).toBe('312px');
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  test('opens a thread at the start of its latest user message', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList?.contains('conversation-scroll')) return { top: 100, bottom: 700, left: 0, right: 900, width: 900, height: 600 };
      const tops = { 'user-1': 180, 'assistant-1': 260, 'user-2': 460, 'assistant-2': 540 };
      const top = tops[this.dataset?.messageId] ?? 0;
      return { top, bottom: top + 60, left: 0, right: 600, width: 600, height: 60 };
    };
    HTMLElement.prototype.scrollTo = function scrollTo({ top }) { this.scrollTop = top; };

    try {
      root = document.createElement('div');
      document.body.append(root);
      act(() => render(h(WorkspacePage, {
        connection: { id: 'connection-1', label: 'Test Avi', serverUrl: 'http://localhost:18991', apiKey: 'synthetic' },
        globalClient: { request: () => Promise.resolve() },
        discovery: { appVersion: 'test', apiVersion: 1, versions: { core: 2, mcp: { latest: 1 } } },
        models: [{ id: 'model:one', name: 'Model One', reasoning: [] }],
        conversations: [{ id: 'thread-1', title: 'Scroll test', model: 'model:one', projectPath: 'C:\\Code\\avi' }],
        folders: [],
        onRefresh() {},
        onExit() {},
      }), root));

      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

      const area = root.querySelector('.conversation-scroll');
      expect(root.querySelectorAll('.message.user')).toHaveLength(2);
      expect(area.scrollTop).toBe(360);
      expect(area.style.getPropertyValue('--initial-scroll-clearance')).toBe('360px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });
});
