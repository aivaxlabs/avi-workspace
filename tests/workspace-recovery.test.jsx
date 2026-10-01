import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { FakeSocket as OrpcSocket, decodeWireFrame, eventFrame } from './orpc-test-helpers.js';

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

let contextRequests = [];
let answers = 0;

class FakeSocket extends OrpcSocket {
  constructor() {
    super(undefined, undefined);
    queueMicrotask(() => this.ready());
  }

  ready() {
    this.message({ jsonrpc: '2.0', method: 'conversation:ready', params: { sequence: 0, conversationId: 'thread-1' } });
  }

  answer(request) {
    answers++;
    this.message({
      id: request.id,
      result: {
        conversation: { id: 'thread-1', title: 'Recovery test', model: 'model:one', projectPath: 'C:\\Code\\avi' },
        messages: [{ id: 'assistant-1', role: 'assistant', content: `Recovered answer ${answers}` }],
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

  respond(socket, request) {
    if (request.method === 'rpc:discover') { this.message({ id: request.id, result: { versions: { rpc: 1 }, scope: 'conversation', methods: ['conversations:context', 'chat:send'] } }); return; }
    if (request.method === 'conversations:context' && request.json.params.limit !== 1) contextRequests.push(request);
  }
}

globalThis.WebSocket = FakeSocket;

let WorkspacePage;
let root;

beforeAll(async () => {
  ({ WorkspacePage } = await import('../src/components/WorkspacePage.jsx'));
});

afterEach(() => {
  act(() => render(null, root));
  document.body.replaceChildren();
  contextRequests = [];
  answers = 0;
});

async function waitFor(condition) {
  const started = Date.now();
  while (!condition() && Date.now() - started < 2000) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(condition()).toBe(true);
}

describe('conversation recovery', () => {
  test('coalesces overlapping recoveries and recovers again after a stale event', async () => {
    root = document.createElement('div');
    document.body.append(root);
    act(() => render(h(WorkspacePage, {
      connection: { id: 'connection-1', label: 'Test Avi', serverUrl: 'http://localhost:18991', apiKey: 'synthetic' },
      globalClient: { request: () => Promise.resolve() },
      discovery: { appVersion: 'test', apiVersion: 1, versions: { core: 2, mcp: { latest: 1 } } },
      models: [{ id: 'model:one', name: 'Model One', reasoning: [] }],
      conversations: [{ id: 'thread-1', title: 'Recovery test', model: 'model:one', projectPath: 'C:\\Code\\avi' }],
      folders: [],
      onRefresh() {},
      onExit() {},
    }), root));

    await waitFor(() => contextRequests.length === 1);
    const socket = FakeSocket.instances.at(-1);
    expect(root.querySelector('.conversation-skeleton')).not.toBeNull();

    for (const id of ['ready1', 'ready2']) {
      socket.message(await eventFrame('conversation.ready', { sequence: 0, conversationId: 'thread-1' }, { id }));
      await waitFor(() => socket.rawSent.some((wire) => {
        const frame = decodeWireFrame(wire);
        return frame.type === 'RES' && frame.baseId === id && !frame.control;
      }));
    }
    expect(contextRequests).toHaveLength(1);

    socket.answer(contextRequests[0]);
    await waitFor(() => contextRequests.length === 2);
    socket.answer(contextRequests[1]);
    await waitFor(() => root.textContent.includes('Recovered answer 2'));
    expect(root.querySelector('.conversation-skeleton')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(contextRequests).toHaveLength(2);

    socket.message(eventFrame('conversation.event', { sequence: 9 }, { eventId: 'evt-stale', expiresAt: Date.now() - 1 }));
    await waitFor(() => contextRequests.length === 3);
    socket.answer(contextRequests[2]);
    await waitFor(() => root.textContent.includes('Recovered answer 3'));
  });
});
