import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { METHODS } from '../src/rpc/contracts.js';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
});

let Composer;

beforeAll(async () => {
  ({ Composer } = await import('../src/components/Composer.jsx'));
});

afterEach(() => {
  document.body.replaceChildren();
});

const models = [
  { id: 'model:one', name: 'Model One', reasoning: ['low', 'high'] },
  { id: 'model:two', name: 'Model Two', reasoning: ['medium', 'high'] },
];

function createState(overrides = {}) {
  return {
    conversation: {
      id: 'thread-1',
      model: 'model:one',
      projectPath: 'C:\\Code\\avi',
      projectDisplayPath: 'C:\\Code\\avi',
      gitBranch: 'main',
      orchestrationMode: null,
      goal: null,
    },
    composer: {
      permissionMode: 'full_access',
      model: 'model:one',
      reasoningEffort: 'high',
      workMode: 'plan',
      ultraMode: false,
      draftText: 'Persisted draft',
      attachments: [{ id: 'a1', kind: 'context_marker', markerType: 'file_reference', markerKey: 'README.md', name: 'README.md' }],
    },
    contextUsage: { tokens: 640, limit: 1000 },
    messages: [
      { id: 'u1', role: 'user', content: 'Change it' },
      { id: 'a1', role: 'assistant', edits: [{ filePath: 'src/a.js', before: 'one\ntwo', after: 'one\nthree\nfour' }] },
    ],
    queue: {
      steer: [{ id: 's1', content: 'Steering prompt' }],
      queued: [{ id: 'q1', content: 'First queued' }, { id: 'q2', content: 'Second queued' }],
    },
    tasks: [{ title: 'Done', done: true }, { title: 'Pending', done: false }],
    subagents: [{ id: 'agent-1', workStatus: 'working' }, { id: 'agent-2', workStatus: 'failed' }],
    rubberDucks: [{ id: 'duck-1', status: 'completed' }],
    run: { active: false },
    ...overrides,
  };
}

function mount(state = createState(), overrides = {}) {
  const root = document.createElement('div');
  const calls = [];
  const opened = [];
  document.body.append(root);
  const client = {
    request(method, params) {
      calls.push({ method, params });
      return Promise.resolve({ queueOrder: [] });
    },
  };
  const props = {
    client,
    models,
    onSent() { opened.push('sent'); },
    onStop() { opened.push('stop'); return Promise.resolve(); },
    onSideChat() { opened.push('side'); },
    onOpenTasks() { opened.push('tasks'); },
    onOpenAgents() { opened.push('agents'); },
    onQueueOrder() { opened.push('queue'); },
    onError(error) { throw error; },
  };
  act(() => render(h(Composer, { ...props, ...overrides, state }), root));
  return {
    root,
    calls,
    opened,
    rerender(nextState) { act(() => render(h(Composer, { ...props, ...overrides, state: nextState }), root)); },
  };
}

function buttonWithText(root, text) {
  return [...root.querySelectorAll('button')].find((button) => button.textContent.trim().includes(text));
}

async function flush() {
  await act(async () => Promise.resolve());
}

describe('composer parity', () => {
  test('hydrates the RPC snapshot, renders authoritative strips and autosaves the complete draft', async () => {
    const { root, calls, opened } = mount();
    const textarea = root.querySelector('textarea');

    expect(textarea.value).toBe('Persisted draft');
    expect(root.textContent).toContain('1 file');
    expect(root.textContent).toContain('+2');
    expect(root.textContent).toContain('-1');
    expect(root.textContent).toContain('1/2 tasks completed');
    expect(root.textContent).toContain('1 sub-agents working, 1 finished, 1 failed');
    expect(root.querySelector('[aria-label="Steer messages"] .queue-strip-header').textContent).toContain('Applied after the current assistant turn');
    expect(root.querySelector('[aria-label="Queue messages"] .queue-strip-header').textContent).toContain('Sent after the assistant finishes');
    expect(root.querySelectorAll('.composer-queues > .queue-strip')).toHaveLength(2);
    expect(root.querySelectorAll('.queue-list > li')).toHaveLength(3);
    expect(root.textContent).toContain('Steering prompt');
    expect(root.textContent).toContain('First queued');
    expect(root.textContent).toContain('C:\\Code\\avi');
    expect(root.textContent).toContain('main');
    expect(root.textContent).toContain('64%');
    expect(root.querySelector('.permission-control > button > i').classList.contains('ri-shield-flash-line')).toBe(true);

    act(() => buttonWithText(root, 'tasks completed').click());
    act(() => buttonWithText(root, 'sub-agents working').click());
    expect(opened).toContain('tasks');
    expect(opened).toContain('agents');

    act(() => {
      textarea.value = 'Updated draft';
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const save = calls.filter((call) => call.method === METHODS.composerSave).at(-1);
    expect(save.params).toEqual({
      permissionMode: 'full_access',
      model: 'model:one',
      reasoningEffort: 'high',
      workMode: 'plan',
      ultraMode: false,
      draftText: 'Updated draft',
      attachments: [{ id: 'a1', kind: 'context_marker', markerType: 'file_reference', markerKey: 'README.md', name: 'README.md' }],
    });
  });

  test('preserves the local draft when recovery returns a new snapshot for the same thread', async () => {
    const mounted = mount();
    const textarea = mounted.root.querySelector('textarea');
    act(() => {
      textarea.value = 'Local unsaved text';
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await flush();

    mounted.rerender(createState({
      composer: { ...createState().composer, draftText: 'Older server draft' },
      contextUsage: { tokens: 700, limit: 1000 },
    }));

    expect(mounted.root.querySelector('textarea').value).toBe('Local unsaved text');
    expect(mounted.root.textContent).toContain('70%');
  });

  test('applies queue actions and exposes Desktop-style permission and model menus', async () => {
    const { root, calls } = mount();

    act(() => root.querySelector('[aria-label="Move queue message down"]').click());
    await flush();
    expect(calls.find((call) => call.method === METHODS.reorderQueued)?.params).toEqual({ queueType: 'queue', messageIds: ['q2', 'q1'] });

    act(() => buttonWithText(root, 'Steer').click());
    await flush();
    expect(calls.filter((call) => call.method === METHODS.reorderQueued).at(-1).params).toEqual({ queueType: 'queue', messageIds: ['q1', 'q2'], steerMessageId: 'q1' });

    act(() => root.querySelector('[aria-label="Cancel queued message"]').click());
    await flush();
    expect(calls.find((call) => call.method === METHODS.cancelQueued)?.params).toEqual({ messageId: 's1' });

    act(() => buttonWithText(root, 'Full access').click());
    expect(root.querySelector('.permission-menu').textContent).toContain('Ask only before destructive actions');
    act(() => buttonWithText(root.querySelector('.permission-menu'), 'Approve for me').click());
    expect(buttonWithText(root, 'Approve for me')).toBeTruthy();

    act(() => buttonWithText(root, 'Model One').click());
    expect(root.querySelector('.advanced-menu-header').textContent).toContain('Advanced');
    expect(root.querySelector('[aria-label="Choose model"]').textContent).toContain('Model One');
    expect(root.querySelector('[aria-label="Choose effort"]').textContent).toContain('high');

    act(() => root.querySelector('[aria-label="Choose model"]').click());
    expect(root.querySelector('[aria-label="Models"]').textContent).toContain('Model Two');
    act(() => buttonWithText(root.querySelector('[aria-label="Models"]'), 'Model Two').click());
    expect(buttonWithText(root, 'Model Two')).toBeTruthy();

    act(() => buttonWithText(root, 'Model Two').click());
    act(() => root.querySelector('[aria-label="Choose effort"]').click());
    expect(root.querySelector('[aria-label="Reasoning effort"]').textContent).toContain('medium');
    act(() => buttonWithText(root.querySelector('[aria-label="Reasoning effort"]'), 'high').click());
    expect(buttonWithText(root, 'Model Two').textContent).toContain('high');
  });

  test('uses Avi message delivery mode for Enter and reverses it for Ctrl+Enter', async () => {
    const mounted = mount(createState({ run: { active: true } }), { messageDeliveryMode: 'queue' });
    const textarea = mounted.root.querySelector('textarea');
    expect(mounted.root.querySelector('[aria-label="Running message behavior"]')).toBeNull();

    act(() => textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    await flush();
    expect(mounted.calls.find((call) => call.method === METHODS.send)?.params.steer).toBe(false);

    act(() => {
      textarea.value = 'Prioritize this';
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await flush();
    act(() => textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })));
    await flush();
    expect(mounted.calls.filter((call) => call.method === METHODS.send).at(-1).params.steer).toBe(true);
  });

  test('sends all composer controls and starts a new Goal through its dedicated RPC method', async () => {
    const regular = mount(createState({
      composer: { permissionMode: 'approve_for_me', model: 'model:two', reasoningEffort: 'medium', workMode: null, ultraMode: true, draftText: '', attachments: [] },
    }));
    const textarea = regular.root.querySelector('textarea');
    act(() => {
      textarea.value = 'Run the team';
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await flush();
    act(() => regular.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(regular.calls.find((call) => call.method === METHODS.send)?.params).toEqual({
      text: 'Run the team',
      model: 'model:two',
      reasoningEffort: 'medium',
      attachments: [],
      permissionMode: 'approve_for_me',
      workMode: null,
      ultraMode: true,
      steer: false,
    });

    document.body.replaceChildren();
    const goal = mount(createState({
      composer: { permissionMode: 'full_access', model: 'model:one', reasoningEffort: 'high', workMode: 'goal', ultraMode: false, draftText: 'Ship parity', attachments: [] },
    }));
    act(() => goal.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(goal.calls.find((call) => call.method === METHODS.startGoal)?.params).toEqual({
      specification: 'Ship parity',
      model: 'model:one',
      reasoningEffort: 'high',
      attachments: [],
      permissionMode: 'full_access',
      ultraMode: false,
    });
  });
});
