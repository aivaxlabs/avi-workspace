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

const queuedMessage = { id: 'queued-1', role: 'user', content: 'Queued request', status: 'queued' };
const steeredMessage = { id: 'steer-1', role: 'user', content: 'Steered request', status: 'steered' };

class FakeSocket extends EventTarget {
  static OPEN = 1;

  constructor() {
    super();
    this.protocol = 'avi-rpc-v1';
    this.readyState = 0;
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
        conversation: { id: 'thread-1', title: 'Pending test', model: 'model:one', projectPath: 'C:\\Code\\avi' },
        messages: [
          { id: 'user-1', role: 'user', content: 'Sent request' },
          { id: 'assistant-1', role: 'assistant', content: 'Sent answer' },
          queuedMessage,
          steeredMessage,
        ],
        messagePage: { cursor: null, hasMore: false },
        queue: { steer: [steeredMessage], queued: [queuedMessage] },
        run: { active: true, startedAt: 1 },
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

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

globalThis.WebSocket = FakeSocket;

let WorkspacePage;

beforeAll(async () => {
  ({ WorkspacePage } = await import('../src/components/WorkspacePage.jsx'));
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('chat view pending queue messages', () => {
  test('renders queued and steered prompts only in the Composer strips', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    act(() => render(h(WorkspacePage, {
      connection: { id: 'connection-1', label: 'Test Avi', serverUrl: 'http://localhost:18991', apiKey: 'synthetic' },
      globalClient: { request: () => Promise.resolve() },
      discovery: { appVersion: 'test', apiVersion: 1, versions: { core: 2, mcp: { latest: 1 } } },
      models: [{ id: 'model:one', name: 'Model One', reasoning: [] }],
      conversations: [{ id: 'thread-1', title: 'Pending test', model: 'model:one', projectPath: 'C:\\Code\\avi' }],
      folders: [],
      onRefresh() {},
      onExit() {},
    }), root));

    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

    const timeline = root.querySelector('.conversation-scroll');
    expect(timeline.textContent).toContain('Sent request');
    expect(timeline.textContent).toContain('Sent answer');
    expect(timeline.textContent).not.toContain('Queued request');
    expect(timeline.textContent).not.toContain('Steered request');
    expect(root.querySelectorAll('.conversation-scroll .message.user')).toHaveLength(1);

    expect(root.querySelector('[aria-label="Queue messages"]').textContent).toContain('Queued request');
    expect(root.querySelector('[aria-label="Steer messages"]').textContent).toContain('Steered request');
  });
});
