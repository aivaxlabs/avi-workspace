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

const discoveryAll = { appVersion: 'test', apiVersion: 1, versions: { rpc: 1 }, methods: Object.values(METHODS) };

function discoveryWithout(...keys) {
  const excluded = keys.map((key) => METHODS[key]);
  return { ...discoveryAll, methods: Object.values(METHODS).filter((method) => !excluded.includes(method)) };
}

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
  const errors = [];
  document.body.append(root);
  const draftCache = overrides.draftCache ?? new Map();
  const { respond, ...props } = overrides;
  const client = {
    request(method, params) {
      calls.push({ method, params });
      return respond ? respond(method, params) : Promise.resolve({ queueOrder: [] });
    },
  };
  const rendered = {
    client,
    discovery: discoveryAll,
    draftCache,
    models,
    onSent() { opened.push('sent'); },
    onStop() { opened.push('stop'); return Promise.resolve(); },
    onSideChat() { opened.push('side'); },
    onOpenTasks() { opened.push('tasks'); },
    onOpenAgents() { opened.push('agents'); },
    onQueueOrder() { opened.push('queue'); },
    onError(error) { errors.push(error); },
    ...props,
    state,
  };
  act(() => render(h(Composer, rendered), root));
  return {
    root,
    calls,
    opened,
    errors,
    draftCache,
    client,
    rerender(nextState) { act(() => render(h(Composer, { ...rendered, state: nextState }), root)); },
    unmount() { act(() => render(null, root)); },
  };
}

test('shows Goal progression, terminal tokens, and clears it on thread change', () => {
  const state = createState();
  const goal = { specification: 'Deliver the requested feature', status: 'paused', activeElapsedMs: 3_661_000, resumedAt: null, tokensTransacted: 12500 };
  state.conversation.goal = goal;
  const view = mount(state);
  try {
    const strip = view.root.querySelector('[aria-label="Goal paused"]');
    expect(strip.textContent).toContain(goal.specification);
    expect(strip.textContent).toContain('01:01:01');
    expect(strip.textContent).toContain('Paused');
    expect(strip.querySelector('[aria-label="12500 tokens"]')).toBeNull();
    expect(view.root.querySelector('.composer-strips').firstElementChild).toBe(strip);
    for (const [status, label] of [['completed', 'Completed'], ['blocked', 'Blocked'], ['cancelled', 'Stopped']]) {
      view.rerender({ ...state, conversation: { ...state.conversation, goal: { ...goal, status } } });
      const finished = view.root.querySelector(`[aria-label="Goal ${status}"]`);
      expect(finished.textContent).toContain(label);
      expect(finished.textContent).toContain('01:01:01');
      expect(finished.querySelector('[aria-label="12500 tokens"]').textContent).toBe('13K');
    }
    view.rerender({ ...state, conversation: { ...state.conversation, id: 'other-thread', goal: null } });
    expect(view.root.querySelector('.goal-strip')).toBeNull();
  } finally {
    view.unmount();
  }
});

test('updates active Goal elapsed time without a context refresh', async () => {
  const state = createState();
  state.conversation.goal = { specification: 'Active Goal', status: 'active', activeElapsedMs: 0, resumedAt: new Date(Date.now() - 5000).toISOString() };
  const view = mount(state);
  try {
    const strip = view.root.querySelector('[aria-label="Goal active"]');
    expect(strip.textContent).toContain('Working');
    const before = strip.querySelector('small').textContent;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(strip.querySelector('small').textContent).not.toBe(before);
  } finally {
    view.unmount();
  }
});

function buttonWithText(root, text) {
  return [...root.querySelectorAll('button')].find((button) => button.textContent.trim().includes(text));
}

function type(root, value) {
  const textarea = root.querySelector('textarea');
  act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

async function wait(ms) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function saveCalls(view) {
  return view.calls.filter((call) => call.method === METHODS.composerSave);
}

describe('composer parity', () => {
  test('omits the strip container when empty and restores it when tasks appear', () => {
    const state = createState({ tasks: [], subagents: [], rubberDucks: [], queue: { steer: [], queued: [] } });
    const view = mount(state);
    expect(view.root.querySelector('.composer-strips')).toBeNull();
    view.rerender({ ...state, tasks: [{ title: 'Pending', done: false }] });
    expect(view.root.querySelector('.composer-strips + .composer')).not.toBeNull();
    view.rerender(state);
    expect(view.root.querySelector('.composer-strips')).toBeNull();
  });

  test('hydrates the RPC snapshot, renders authoritative strips and autosaves the complete draft', async () => {
    const view = mount();
    const { root, opened } = view;
    const textarea = root.querySelector('textarea');

    expect(textarea.value).toBe('Persisted draft');
    expect(view.draftCache.get('thread-1').dirty).toBe(false);
    expect(view.draftCache.get('thread-1').draft.draftText).toBe('Persisted draft');
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

    type(root, 'Updated draft');
    await flush();
    expect(view.draftCache.get('thread-1').dirty).toBe(true);
    expect(view.draftCache.get('thread-1').draft.draftText).toBe('Updated draft');
    expect(saveCalls(view)).toHaveLength(0);

    await wait(350);
    expect(saveCalls(view).at(-1).params).toEqual({
      permissionMode: 'full_access',
      model: 'model:one',
      reasoningEffort: 'high',
      workMode: 'plan',
      ultraMode: false,
      draftText: 'Updated draft',
      attachments: [{ id: 'a1', kind: 'context_marker', markerType: 'file_reference', markerKey: 'README.md', name: 'README.md' }],
    });
    expect(root.querySelector('.composer-save-status').classList.contains('is-saved')).toBe(true);
    expect(view.draftCache.get('thread-1').dirty).toBe(false);
  });

  test('preserves the local draft when recovery returns a new snapshot for the same thread', async () => {
    const view = mount();
    type(view.root, 'Local unsaved text');
    await flush();

    view.rerender(createState({
      composer: { ...createState().composer, draftText: 'Older server draft' },
      contextUsage: { tokens: 700, limit: 1000 },
    }));

    expect(view.root.querySelector('textarea').value).toBe('Local unsaved text');
    expect(view.root.textContent).toContain('70%');
  });

  test('hydrates from the per-connection cache when returning and re-saves only unsynced entries', async () => {
    const cache = new Map();
    const first = mount(createState(), { draftCache: cache });
    type(first.root, 'Typed locally');
    await wait(350);
    expect(cache.get('thread-1').dirty).toBe(false);
    first.unmount();

    const staleSnapshot = createState({ composer: { ...createState().composer, draftText: 'Older server draft' } });
    const returned = mount(staleSnapshot, { draftCache: cache });
    expect(returned.root.querySelector('textarea').value).toBe('Typed locally');
    await wait(350);
    expect(saveCalls(returned)).toHaveLength(0);
    returned.unmount();

    cache.set('thread-1', { ...cache.get('thread-1'), dirty: true });
    const converging = mount(staleSnapshot, { draftCache: cache });
    expect(converging.root.querySelector('textarea').value).toBe('Typed locally');
    await wait(350);
    expect(saveCalls(converging)).toHaveLength(1);
    expect(cache.get('thread-1').dirty).toBe(false);
  });

  test('preserves unsynced cache on cleanup and saves when reopened', async () => {
    const cache = new Map();
    const flushCalls = [];
    const view = mount(createState(), {
      draftCache: cache,
      client: {
        request(method, params) {
          flushCalls.push({ method, params });
          return Promise.reject(new Error('RPC socket is not connected.'));
        },
      },
    });
    type(view.root, 'Offline edits');
    await flush();
    view.unmount();

    expect(flushCalls.filter((call) => call.method === METHODS.composerSave)).toHaveLength(0);
    expect(cache.get('thread-1').dirty).toBe(true);

    const back = mount(createState(), { draftCache: cache });
    expect(back.root.querySelector('textarea').value).toBe('Offline edits');
    await wait(350);
    expect(saveCalls(back)).toHaveLength(1);
    expect(cache.get('thread-1').dirty).toBe(false);
  });

  test('reports unsupported saving and never calls composer-state:save', async () => {
    const view = mount(createState(), { discovery: discoveryWithout('composerSave') });
    type(view.root, 'Should not sync');
    await wait(400);
    expect(saveCalls(view)).toHaveLength(0);
    expect(view.root.querySelector('.composer-save-status').classList.contains('is-unsupported')).toBe(true);
    expect(view.root.querySelector('.composer-save-status').textContent).toContain('Draft only in this tab');
    expect(view.draftCache.get('thread-1').dirty).toBe(true);
  });

  test('marks unsynced saves and retries explicitly without an automatic failure loop', async () => {
    let failures = 2;
    const view = mount(createState(), {
      respond(method) {
        if (method === METHODS.composerSave && failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('Save failed'));
        }
        return Promise.resolve({});
      },
    });
    type(view.root, 'Retried draft');
    await wait(350);
    expect(view.root.querySelector('.composer-save-status').classList.contains('is-unsynced')).toBe(true);
    expect(view.root.querySelector('.composer-save-status').textContent).toContain('Not synced');
    expect(view.draftCache.get('thread-1').dirty).toBe(true);

    act(() => buttonWithText(view.root, 'Retry').click());
    await flush();
    expect(view.root.querySelector('.composer-save-status').classList.contains('is-unsynced')).toBe(true);

    await wait(1100);
    expect(saveCalls(view)).toHaveLength(2);
    act(() => buttonWithText(view.root, 'Retry').click());
    await flush();
    expect(saveCalls(view)).toHaveLength(3);
    expect(view.root.querySelector('.composer-save-status').classList.contains('is-saved')).toBe(true);
    expect(view.draftCache.get('thread-1').dirty).toBe(false);
  });

  test('pastes images and files, previews images and sends inline attachments', async () => {
    const view = mount(createState({ composer: { ...createState().composer, attachments: [] } }));
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new window.File(['image'], 'shot.png', { type: 'image/png' }), new window.File(['notes'], 'notes.txt', { type: 'text/plain' })] } });
    await act(async () => { view.root.querySelector('textarea').dispatchEvent(event); await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(event.defaultPrevented).toBe(true);
    expect(view.root.querySelector('.composer-markers img').getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=');
    expect(view.draftCache.get('thread-1').draft.attachments.map((item) => item.kind)).toEqual(['image_url', 'file']);
    act(() => view.root.querySelector('[aria-label="Remove notes.txt"]').click());
    act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    const sent = view.calls.find((call) => call.method === METHODS.send);
    expect(sent.params.attachments).toHaveLength(1);
    expect(sent.params.attachments[0].source).toBe('clipboard');
    expect(sent.params.attachments[0].path).toBeUndefined();
    view.unmount();
  });

  test('rejects oversized clipboard files and leaves ordinary text paste untouched', async () => {
    const view = mount(createState({ composer: { ...createState().composer, attachments: [] } }));
    const textEvent = new window.Event('paste', { bubbles: true, cancelable: true });
    act(() => view.root.querySelector('textarea').dispatchEvent(textEvent));
    expect(textEvent.defaultPrevented).toBe(false);
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new window.File([new Uint8Array(512 * 1024 + 1)], 'large.png', { type: 'image/png' })] } });
    await act(async () => { view.root.querySelector('textarea').dispatchEvent(event); });
    expect(view.errors[0].message).toContain('512 KiB');
    expect(view.root.querySelector('.composer-markers')).toBeNull();
    expect(saveCalls(view)).toHaveLength(0);
    view.unmount();
  });

  test('serializes saves and keeps newer edits dirty until their own request resolves', async () => {
    const pending = [];
    const view = mount(createState(), {
      respond(method) {
        return method === METHODS.composerSave ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve({});
      },
    });
    type(view.root, 'First draft');
    await wait(350);
    type(view.root, 'Latest draft');
    await wait(350);
    expect(saveCalls(view)).toHaveLength(1);
    expect(view.draftCache.get('thread-1').dirty).toBe(true);
    await act(async () => { pending[0]({}); await Promise.resolve(); });
    expect(saveCalls(view)).toHaveLength(2);
    expect(saveCalls(view)[1].params.draftText).toBe('Latest draft');
    expect(view.draftCache.get('thread-1').dirty).toBe(true);
    await act(async () => { pending[1]({}); await Promise.resolve(); });
    expect(view.draftCache.get('thread-1').dirty).toBe(false);
    view.unmount();
  });

  test('keeps the typed text while a send is pending and awaits onSent', async () => {
    let resolveSend;
    const sentOrder = [];
    const view = mount(createState(), {
      respond(method) {
        if (method === METHODS.send) return new Promise((resolve) => { resolveSend = resolve; });
        return Promise.resolve({});
      },
      onSent() { sentOrder.push('sent'); return Promise.resolve(); },
    });
    type(view.root, 'Pending message');
    await flush();
    act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(view.calls.filter((call) => call.method === METHODS.send)).toHaveLength(1);
    expect(view.root.querySelector('textarea').value).toBe('Pending message');
    expect(view.root.querySelector('[aria-label="Send"]').disabled).toBe(true);

    resolveSend({});
    await flush();
    expect(view.root.querySelector('textarea').value).toBe('');
    expect(sentOrder).toEqual(['sent']);
  });

  test('surfaces onSent rejections through onError after clearing the draft', async () => {
    const view = mount(createState(), {
      onSent() { return Promise.reject(new Error('refresh failed')); },
    });
    type(view.root, 'Hello');
    await flush();
    act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(view.calls.filter((call) => call.method === METHODS.send)).toHaveLength(1);
    expect(view.errors.map((error) => error.message)).toContain('refresh failed');
    expect(view.root.querySelector('textarea').value).toBe('');
  });

  test('gates optional composer methods through discovery', async () => {
    const view = mount(createState(), { discovery: discoveryWithout('mentions', 'commands', 'reorderQueued', 'cancelQueued', 'send', 'stop', 'startGoal') });
    const { root, calls, errors } = view;

    expect([...root.querySelectorAll('.queue-actions button')].every((button) => button.disabled)).toBe(true);
    expect(root.querySelector('[aria-label="Send"]').disabled).toBe(true);

    type(root, '@README');
    await wait(200);
    expect(calls.filter((call) => call.method === METHODS.mentions)).toHaveLength(0);
    expect(root.querySelector('.command-picker')).toBeNull();

    act(() => root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(calls.filter((call) => call.method === METHODS.send)).toHaveLength(0);
    expect(errors.map((error) => error.message)).toContain('Sending messages is not available on this Avi instance.');

    type(root, '/stop');
    await flush();
    act(() => root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(calls.filter((call) => call.method === METHODS.stop)).toHaveLength(0);
    expect(errors.map((error) => error.message)).toContain('Stopping runs is not available on this Avi instance.');

    const goal = mount(createState({ composer: { ...createState().composer, draftText: 'Ship parity', workMode: 'goal' } }), { discovery: discoveryWithout('startGoal') });
    act(() => goal.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(goal.calls.filter((call) => call.method === METHODS.startGoal)).toHaveLength(0);
    expect(goal.errors.map((error) => error.message)).toContain('Starting Goals is not available on this Avi instance.');
  });

  test('opens the mobile queue sheet, moves messages and restores focus on close', async () => {
    const view = mount();
    const trigger = view.root.querySelector('.mobile-queue-summary');
    act(() => trigger.click());
    const sheet = document.querySelector('[aria-label="Manage queued messages"]');
    expect(sheet).not.toBeNull();
    expect(sheet.textContent).toContain('First queued');
    expect(document.activeElement.getAttribute('aria-label')).toBe('Close queued messages');
    act(() => sheet.querySelector('[aria-label="Actions for message 1 in Queue"]').click());
    act(() => buttonWithText(sheet, 'Move down').click());
    await flush();
    expect(view.calls.find((call) => call.method === METHODS.reorderQueued).params).toEqual({ queueType: 'queue', messageIds: ['q2', 'q1'] });
    expect(sheet.querySelector('[role="status"]').textContent).toBe('Moved to position 2');
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('.queue-sheet')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    view.unmount();
  });

  test('keeps queue action failures visible inside the sheet', async () => {
    const view = mount(createState(), { respond: () => Promise.reject(new Error('Queue unavailable')) });
    act(() => view.root.querySelector('.mobile-queue-summary').click());
    const sheet = document.querySelector('.queue-sheet');
    act(() => sheet.querySelector('[aria-label="Actions for message 1 in Queue"]').click());
    act(() => buttonWithText(sheet, 'Remove from queue').click());
    await flush();
    expect(sheet.querySelector('[role="alert"]').textContent).toBe('Queue unavailable');
    expect(sheet.textContent).toContain('First queued');
    view.unmount();
  });

  test('applies queue actions and exposes Desktop-style permission and model menus', async () => {
    const view = mount();
    const { root, calls } = view;

    act(() => root.querySelector('[aria-label="Move queue message down"]').click());
    await flush();
    expect(calls.find((call) => call.method === METHODS.reorderQueued)?.params).toEqual({ queueType: 'queue', messageIds: ['q2', 'q1'] });

    act(() => root.querySelector('[aria-label="Steer queued message"]').click());
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
    const view = mount(createState({ run: { active: true } }), { messageDeliveryMode: 'queue' });
    const textarea = view.root.querySelector('textarea');
    expect(view.root.querySelector('[aria-label="Running message behavior"]')).toBeNull();

    act(() => textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    await flush();
    expect(view.calls.find((call) => call.method === METHODS.send)?.params.steer).toBe(false);

    type(view.root, 'Prioritize this');
    await flush();
    act(() => textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })));
    await flush();
    expect(view.calls.filter((call) => call.method === METHODS.send).at(-1).params.steer).toBe(true);
  });

  test('sends all composer controls and starts a new Goal through its dedicated RPC method', async () => {
    const regular = mount(createState({
      composer: { permissionMode: 'approve_for_me', model: 'model:two', reasoningEffort: 'medium', workMode: null, ultraMode: true, draftText: '', attachments: [] },
    }));
    const textarea = regular.root.querySelector('textarea');
    type(regular.root, 'Run the team');
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
