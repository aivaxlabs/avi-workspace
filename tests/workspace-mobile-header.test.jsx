import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';

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
    if (request.method === 'conversations:context') {
      queueMicrotask(() => this.message({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          conversation: { id: 'thread-1', title: 'Mobile thread', model: 'model:one', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi' },
          messages: [{ id: 'user-1', role: 'user', content: 'Mobile request' }],
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
    } else if (request.id) {
      queueMicrotask(() => this.message({ jsonrpc: '2.0', id: request.id, result: true }));
    }
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
  document.body.style.overflow = '';
  FakeSocket.instances.length = 0;
  root = null;
});

describe('workspace mobile shell', () => {
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
    expect(header.textContent).toContain('Mobile thread');
    expect(header.textContent).toContain('avi');
    expect(root.querySelector('.auxiliary-panel')).toBeNull();

    act(() => root.querySelector('[aria-label="Open navigation"]').click());
    expect(root.querySelector('.mobile-drawer[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');
    act(() => root.querySelector('.mobile-drawer .thread-open').click());
    expect(root.querySelector('.mobile-drawer')).toBeNull();

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
