import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { FakeSocket as OrpcSocket } from './orpc-test-helpers.js';

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

class FakeSocket extends OrpcSocket {
  constructor() {
    super(undefined, undefined);
    queueMicrotask(() => {
      this.message({ jsonrpc: '2.0', method: 'conversation:ready', params: { sequence: 0, conversationId: 'thread-1' } });
    });
  }

  respond(socket, request) {
    if (request.method === 'rpc:discover') { this.message({ id: request.id, result: { versions: { rpc: 1 }, scope: 'conversation', methods: ['conversations:context', 'conversations:messages', 'composer-state:save', 'chat:send'] } }); return; }
    if (request.method !== 'conversations:context') return;
    this.message({
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
    });
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

  test('opens at the bottom and offers a floating return button after scrolling away', async () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList?.contains('conversation-scroll') ? 1200 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('conversation-scroll') ? 600 : 0; } });
    HTMLElement.prototype.scrollTo = function scrollTo({ top }) {
      this.scrollTop = top;
      this.dispatchEvent(new window.Event('scroll'));
    };

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
      expect(area.scrollTop).toBe(600);

      act(() => {
        area.scrollTop = 300;
        area.dispatchEvent(new window.Event('scroll', { bubbles: true }));
      });
      const returnButton = root.querySelector('[aria-label="Scroll to latest message"]');
      expect(returnButton).not.toBeNull();

      act(() => returnButton.click());
      expect(area.scrollTop).toBe(600);
      expect(root.querySelector('[aria-label="Scroll to latest message"]')).toBeNull();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      else delete HTMLElement.prototype.scrollHeight;
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      else delete HTMLElement.prototype.clientHeight;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  test('minimizes the mobile Composer on scroll and expands it on tap', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

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
      expect(root.querySelector('.composer-wrap').classList.contains('is-compact')).toBeFalse();

      act(() => {
        area.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40, bubbles: true }));
        area.scrollTop = 40;
        area.dispatchEvent(new window.Event('scroll', { bubbles: true }));
      });
      expect(root.querySelector('.composer-wrap').classList.contains('is-compact')).toBeTrue();

      act(() => root.querySelector('[aria-label="Expand message composer"]').click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(root.querySelector('.composer-wrap').classList.contains('is-compact')).toBeFalse();
      expect(document.activeElement).toBe(root.querySelector('textarea'));

      act(() => {
        area.scrollTop = 20;
        area.dispatchEvent(new window.Event('scroll', { bubbles: true }));
      });
      expect(root.querySelector('.composer-wrap').classList.contains('is-compact')).toBeFalse();

      act(() => {
        area.dispatchEvent(new window.Event('touchmove', { bubbles: true }));
        area.scrollTop = 10;
        area.dispatchEvent(new window.Event('scroll', { bubbles: true }));
      });
      expect(root.querySelector('.composer-wrap').classList.contains('is-compact')).toBeTrue();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
