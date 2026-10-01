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
    rerender(nextState, nextProps = {}) { act(() => render(h(Composer, { ...rendered, ...nextProps, state: nextState }), root)); },
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

test('uses configured intelligence levels and saves the selected model and effort', async () => {
  const view = mount(createState(), { intelligenceLevels: [
    { modelId: 'model:one', reasoningEffort: 'low' },
    { modelId: 'model:one', reasoningEffort: 'high' },
    { modelId: 'model:two', reasoningEffort: null },
  ] });
  act(() => view.root.querySelector('.model-chip').click());
  const slider = view.root.querySelector('input[type="range"]');
  expect(slider.value).toBe('1');
  act(() => { slider.value = '2'; slider.dispatchEvent(new window.Event('input', { bubbles: true })); });
  expect(view.root.querySelector('.model-chip').textContent).toContain('Model Two');
  expect(view.root.querySelector('.model-chip').textContent).toContain('medium');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  expect(view.calls.filter((call) => call.method === METHODS.composerSave).at(-1).params).toMatchObject({ model: 'model:two', reasoningEffort: 'medium' });
  act(() => buttonWithText(view.root, 'Advanced').click());
  expect(view.root.querySelector('[aria-label="Advanced model settings"]')).not.toBeNull();
  view.unmount();
});

test('keeps the full picker when fewer than three configured models are available', () => {
  const view = mount(createState(), { intelligenceLevels: [{ modelId: 'model:one' }, { modelId: 'model:two' }, { modelId: 'missing' }] });
  act(() => view.root.querySelector('.model-chip').click());
  expect(view.root.querySelector('input[type="range"]')).toBeNull();
  expect(view.root.querySelector('[aria-label="Advanced model settings"]')).not.toBeNull();
  view.unmount();
});

describe('mobile composer', () => {
  test('opens the model sheet, preserves supported effort and restores focus', () => {
    const view = mount(createState(), { mobile: true, intelligenceLevels: [
      { modelId: 'model:one', reasoningEffort: 'low' },
      { modelId: 'model:one', reasoningEffort: 'high' },
      { modelId: 'model:two', reasoningEffort: 'medium' },
    ] });
    try {
      const chip = view.root.querySelector('.model-chip');
      act(() => chip.click());
      const sheet = document.querySelector('[role="dialog"][aria-label="Choose model"]');
      expect(sheet?.getAttribute('aria-modal')).toBe('true');
      expect(view.root.querySelector('[aria-label="Choose model"]')).toBeNull();
      expect(sheet.querySelector('.intelligence-slider input')).not.toBeNull();
      expect(sheet.querySelectorAll('[role="radio"]')).toHaveLength(2);
      act(() => buttonWithText(sheet, 'Model Two').click());
      expect(chip.textContent).toContain('Model Two');
      expect(chip.textContent).toContain('high');
      expect(sheet.querySelector('[role="radio"][aria-checked="true"]').textContent).toContain('model:two');
      act(() => buttonWithText(sheet, 'medium').click());
      expect(chip.textContent).toContain('medium');
      act(() => buttonWithText(sheet, 'Model One').click());
      expect(chip.textContent).toContain('low');
      act(() => buttonWithText(sheet, 'Model Two').click());
      expect(chip.textContent).toContain('medium');
      act(() => sheet.querySelector('[role="radio"][aria-checked="true"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
      expect(chip.textContent).toContain('Model One');
      expect(document.activeElement === sheet.querySelector('[role="radio"][aria-checked="true"]')).toBe(true);
      act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
      expect(document.querySelector('.model-sheet')).toBeNull();
      expect(document.activeElement === chip).toBe(true);
      act(() => chip.click());
      act(() => document.querySelector('.queue-sheet-backdrop').click());
      expect(document.querySelector('.model-sheet')).toBeNull();
    } finally { view.unmount(); }
  });

  test('exposes native photo and video inputs without unsupported audio recording', async () => {
    const recorder = window.MediaRecorder;
    window.MediaRecorder = undefined;
    const view = mount(createState(), { mobile: true });
    try {
      act(() => view.root.querySelector('[aria-label="Composer actions"]').click());
      const menu = view.root.querySelector('.plus-menu');
      for (const label of ['Photo library', 'Take photo', 'Record video']) expect(buttonWithText(menu, label)).toBeTruthy();
      expect(buttonWithText(menu, 'Record audio')).toBeUndefined();
      const photos = view.root.querySelector('input[aria-label="Photo library"]');
      const camera = view.root.querySelector('input[aria-label="Take photo"]');
      const video = view.root.querySelector('input[aria-label="Record video"]');
      expect(photos.accept).toBe('image/*,video/*');
      expect(photos.multiple).toBe(true);
      expect(photos.hasAttribute('capture')).toBe(false);
      expect(camera.accept).toBe('image/*');
      expect(camera.getAttribute('capture')).toBe('environment');
      expect(video.accept).toBe('video/*');
      expect(video.getAttribute('capture')).toBe('environment');
      expect([photos, camera, video].every((input) => input.hidden)).toBe(true);
      Object.defineProperty(video, 'files', { value: [new window.File(['video'], 'clip.mp4', { type: 'video/mp4' })] });
      await act(async () => { video.dispatchEvent(new window.Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(video.value).toBe('');
      expect(view.draftCache.get('thread-1').draft.attachments.at(-1)).toMatchObject({ kind: 'file', mime: 'video/mp4', name: 'clip.mp4' });
      expect(view.root.querySelector('.composer-markers .ri-video-line')).not.toBeNull();
      view.rerender(createState(), { discovery: discoveryWithout('send') });
      expect([photos, camera, video].every((input) => input.disabled)).toBe(true);
      expect(buttonWithText(menu, 'Take photo').disabled).toBe(true);
    } finally { view.unmount(); window.MediaRecorder = recorder; }
  });

  test.each(['audio/mp4', 'audio/webm;codecs=opus'])('records %s as a file attachment and releases the microphone', async (mime) => {
    const originalRecorder = window.MediaRecorder;
    const mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    let trackStops = 0;
    const stream = { getTracks: () => [{ stop: () => { trackStops += 1; } }] };
    const supportedChecks = [];
    window.MediaRecorder = class {
      static isTypeSupported(type) { supportedChecks.push(type); return type === mime; }
      constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new window.Blob(['recorded audio'], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } });
    const view = mount(createState({ composer: { ...createState().composer, attachments: [] } }), { mobile: true });
    try {
      const plus = view.root.querySelector('[aria-label="Composer actions"]');
      act(() => plus.click());
      act(() => buttonWithText(view.root.querySelector('.plus-menu'), 'Record audio').click());
      let sheet = document.querySelector('.audio-recorder-sheet');
      expect(sheet.getAttribute('aria-modal')).toBe('true');
      expect(sheet.querySelector('[role="timer"]').textContent).toBe('00:00');
      expect(buttonWithText(sheet, 'Use recording').disabled).toBe(true);
      act(() => sheet.querySelector('[aria-label="Start recording"]').click());
      await flush();
      expect(supportedChecks[0]).toBe('audio/mp4');
      act(() => sheet.querySelector('[aria-label="Stop recording"]').click());
      await flush();
      expect(trackStops).toBeGreaterThan(0);
      expect(buttonWithText(sheet, 'Use recording').disabled).toBe(false);
      act(() => buttonWithText(sheet, 'Use recording').click());
      await wait(30);
      const attachment = view.draftCache.get('thread-1').draft.attachments[0];
      expect(attachment.kind).toBe('file');
      expect(attachment.mime).toBe(mime);
      expect(attachment.name).toMatch(mime === 'audio/mp4' ? /^recording-\d+\.m4a$/ : /^recording-\d+\.webm$/);
      expect(view.root.querySelector('.composer-markers .ri-mic-line')).not.toBeNull();
      expect(document.querySelector('.audio-recorder-sheet')).toBeNull();
      expect(document.activeElement === plus).toBe(true);
      act(() => plus.click());
      act(() => buttonWithText(view.root.querySelector('.plus-menu'), 'Record audio').click());
      sheet = document.querySelector('.audio-recorder-sheet');
      act(() => sheet.querySelector('[aria-label="Start recording"]').click());
      await flush();
      const before = trackStops;
      view.unmount();
      await flush();
      expect(trackStops).toBeGreaterThan(before);
    } finally {
      view.unmount();
      window.MediaRecorder = originalRecorder;
      if (mediaDevices) Object.defineProperty(navigator, 'mediaDevices', mediaDevices);
      else delete navigator.mediaDevices;
    }
  });

  test('keeps the recording sheet when the attachment is rejected for size', async () => {
    const originalRecorder = window.MediaRecorder;
    const mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new window.Blob(['x'], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    const view = mount(createState({ composer: { ...createState().composer, attachments: [] } }), { mobile: true });
    try {
      act(() => view.root.querySelector('[aria-label="Composer actions"]').click());
      act(() => buttonWithText(view.root.querySelector('.plus-menu'), 'Record audio').click());
      const sheet = document.querySelector('.audio-recorder-sheet');
      act(() => sheet.querySelector('[aria-label="Start recording"]').click());
      await flush();
      act(() => sheet.querySelector('[aria-label="Stop recording"]').click());
      await flush();
      const originalFile = window.File;
      window.File = class extends window.Blob {
        constructor(parts, name, options) { super(parts, options); this.name = name; Object.defineProperty(this, 'size', { value: 10 * 1024 * 1024 + 1 }); }
      };
      try {
        act(() => buttonWithText(sheet, 'Use recording').click());
        await wait(30);
      } finally { window.File = originalFile; }
      expect(view.errors.at(-1).message).toBe('Each file must be 10 MB or smaller.');
      expect(document.querySelector('.audio-recorder-sheet')).not.toBeNull();
      expect(buttonWithText(document.querySelector('.audio-recorder-sheet'), 'Use recording').disabled).toBe(false);
      expect(view.draftCache.get('thread-1')?.draft.attachments ?? []).toHaveLength(0);
    } finally {
      view.unmount();
      window.MediaRecorder = originalRecorder;
      if (mediaDevices) Object.defineProperty(navigator, 'mediaDevices', mediaDevices);
      else delete navigator.mediaDevices;
    }
  });

  test('keeps the model radio group tabbable when the models list changes', () => {
    const state = createState({ composer: { ...createState().composer, model: null } });
    const view = mount(state, { mobile: true, models: [] });
    try {
      view.rerender(state, { models });
      act(() => view.root.querySelector('.model-chip').click());
      const radios = [...document.querySelectorAll('[aria-label="Choose model"] [role="radio"]')];
      expect(radios.length).toBeGreaterThan(1);
      expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    } finally { view.unmount(); }
  });

  test('reports microphone denial and releases late permission results after cancellation', async () => {
    const originalRecorder = window.MediaRecorder;
    const mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    let finish;
    let trackStops = 0;
    let deny = true;
    window.MediaRecorder = class {};
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => deny
      ? Promise.reject(Object.assign(new Error('Denied'), { name: 'NotAllowedError' }))
      : new Promise((resolve) => { finish = resolve; }) } });
    const view = mount(createState(), { mobile: true });
    try {
      const plus = view.root.querySelector('[aria-label="Composer actions"]');
      act(() => plus.click());
      act(() => buttonWithText(view.root.querySelector('.plus-menu'), 'Record audio').click());
      act(() => document.querySelector('[aria-label="Start recording"]').click());
      await flush();
      expect(view.errors[0].message).toContain('Microphone access was denied');
      expect(document.querySelector('.audio-recorder-sheet')).toBeNull();
      deny = false;
      act(() => plus.click());
      act(() => buttonWithText(view.root.querySelector('.plus-menu'), 'Record audio').click());
      act(() => document.querySelector('[aria-label="Start recording"]').click());
      await flush();
      act(() => buttonWithText(document.querySelector('.audio-recorder-sheet'), 'Cancel').click());
      finish({ getTracks: () => [{ stop: () => { trackStops += 1; } }] });
      await flush();
      expect(trackStops).toBe(1);
      expect(document.querySelector('.audio-recorder-sheet')).toBeNull();
    } finally {
      view.unmount();
      window.MediaRecorder = originalRecorder;
      if (mediaDevices) Object.defineProperty(navigator, 'mediaDevices', mediaDevices);
      else delete navigator.mediaDevices;
    }
  });

  test('shows sending and connection-wait feedback while delivery is pending', async () => {
    let finish;
    const state = createState();
    const view = mount(state, { respond: (method) => method === METHODS.send ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}) });
    view.client.status = { status: 'online' };
    try {
      act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await flush();
      expect(view.root.querySelector('.send.is-sending .ri-loader-4-line.spinning')).not.toBeNull();
      expect(view.root.querySelector('.composer-save-status[role="status"]').textContent).toBe('Sending...');
      view.client.status = { status: 'reconnecting' };
      view.rerender({ ...state, run: { active: true } });
      expect(view.root.querySelector('.send.is-sending')).not.toBeNull();
      expect(view.root.querySelector('.composer-save-status').textContent).toBe('Waiting for connection...');
      finish({});
      await flush();
      expect(view.root.querySelector('.send.is-sending')).toBeNull();
    } finally { finish?.({}); view.unmount(); }
  });

  test('announces pending suggestions and empty results without expanding the combobox', async () => {
    let finish;
    const view = mount(createState(), { respond: (method) => method === METHODS.commands ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}) });
    try {
      type(view.root, '$missing');
      await wait(180);
      expect(view.root.querySelector('.command-picker-status[role="status"]').textContent).toBe('Searching...');
      expect(view.root.querySelector('.command-picker-status .spinning')).not.toBeNull();
      expect(view.root.querySelector('textarea').getAttribute('aria-expanded')).toBe('false');
      finish([]);
      await flush();
      expect(view.root.querySelector('.command-picker-status').textContent).toBe('No matches');
      expect(view.root.querySelector('textarea').hasAttribute('aria-controls')).toBe(false);
      type(view.root, '');
      await flush();
      expect(view.root.querySelector('.command-picker')).toBeNull();
    } finally { finish?.([]); view.unmount(); }
  });

  test('shows no empty-result status when the suggestions request fails', async () => {
    const view = mount(createState(), { respond: (method) => method === METHODS.commands ? Promise.reject(new Error('offline')) : Promise.resolve({}) });
    try {
      type(view.root, '$missing');
      await wait(180);
      await flush();
      expect(view.root.querySelector('.command-picker')).toBeNull();
    } finally { view.unmount(); }
  });
});

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

  test('recovers draft saving and sending when conversation discovery arrives', async () => {
    const state = createState();
    const view = mount(state, { discovery: null });
    expect(view.root.querySelector('.composer-save-status').textContent).toContain('Draft only in this tab');
    expect(view.root.querySelector('[aria-label="Send"]').disabled).toBe(true);
    type(view.root, 'Ready to send');
    await flush();

    view.rerender(state, { discovery: discoveryAll });
    expect(view.root.querySelector('[aria-label="Send"]').disabled).toBe(false);
    await wait(350);
    expect(saveCalls(view)).toHaveLength(1);
    expect(view.root.querySelector('.composer-save-status').textContent).toContain('Saved');

    act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(view.calls.filter((call) => call.method === METHODS.send)).toHaveLength(1);
  });

  test('uses last available model when an empty conversation has no persisted model', () => {
    const state = createState({ composer: null, conversation: { ...createState().conversation, model: '' } });
    const preferred = mount(state, { lastModel: 'model:two' });
    expect(preferred.root.querySelector('.model-chip').textContent).toContain('Model Two');
    preferred.unmount();

    const fallback = mount(state, { lastModel: 'model:missing' });
    expect(fallback.root.querySelector('.model-chip').textContent).toContain('Model One');
    fallback.unmount();
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

  test('attaches selected files from the Plus menu and allows selecting again after removal', async () => {
    const view = mount(createState({ composer: { ...createState().composer, attachments: [] } }));
    try {
      const input = view.root.querySelector('input[type="file"]');
      let opened = 0;
      input.click = () => { opened += 1; };
      act(() => view.root.querySelector('[aria-label="Composer actions"]').click());
      act(() => buttonWithText(view.root.querySelector('.plus-menu'), 'Attach files').click());
      expect(opened).toBe(1);
      expect(view.root.querySelector('.plus-menu')).toBeNull();
      expect(input.multiple).toBe(true);
      Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['image'], 'shot.png', { type: 'image/png' }), new window.File(['notes'], 'notes.txt', { type: 'text/plain' })] });
      await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(input.value).toBe('');
      expect(view.root.querySelector('.composer-markers img')).not.toBeNull();
      expect(view.draftCache.get('thread-1').draft.attachments).toHaveLength(2);
      act(() => view.root.querySelector('[aria-label="Remove notes.txt"]').click());
      Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['notes'], 'notes.txt', { type: 'text/plain' })] });
      await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 30)); });
      act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await flush();
      expect(view.calls.find((call) => call.method === METHODS.send).params.attachments.map((item) => item.name)).toEqual(['shot.png', 'notes.txt']);
    } finally { view.unmount(); }
  });

  test('accepts a 10 MiB file and keeps it in the draft for native ORPC chunking', async () => {
    const view = mount(createState({ composer: { ...createState().composer, attachments: [] } }));
    try {
      const input = view.root.querySelector('input[type="file"]');
      Object.defineProperty(input, 'files', { value: [new window.File([new Uint8Array(10 * 1024 * 1024)], 'limit.bin')] });
      await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 100)); });
      expect(view.errors).toHaveLength(0);
      const attachment = view.draftCache.get('thread-1').draft.attachments[0];
      expect(attachment.size).toBe(10 * 1024 * 1024);
      expect(Buffer.from(attachment.dataUrl.split(',')[1], 'base64').length).toBe(10 * 1024 * 1024);
      act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await flush();
      expect(view.calls.find((call) => call.method === METHODS.send).params.attachments[0]).toEqual(attachment);
    } finally { view.unmount(); }
  });

  test('file selection cancellation and oversized files leave attachments unchanged', async () => {
    const view = mount(createState({ composer: { ...createState().composer, attachments: [] } }));
    try {
      const input = view.root.querySelector('input[type="file"]');
      await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
      expect(view.errors).toHaveLength(0);
      Object.defineProperty(input, 'files', { value: [new window.File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.bin')] });
      await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
      expect(view.errors[0].message).toContain('10 MB');
      expect(view.root.querySelector('.composer-markers')).toBeNull();
    } finally { view.unmount(); }
    const unsupported = mount(createState(), { discovery: discoveryWithout('send') });
    try {
      act(() => unsupported.root.querySelector('[aria-label="Composer actions"]').click());
      expect(buttonWithText(unsupported.root.querySelector('.plus-menu'), 'Attach files').disabled).toBe(true);
    } finally { unsupported.unmount(); }
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
    Object.defineProperty(event, 'clipboardData', { value: { files: [new window.File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })] } });
    await act(async () => { view.root.querySelector('textarea').dispatchEvent(event); });
    expect(view.errors[0].message).toContain('10 MB');
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

  test('keeps newer text typed while an earlier message is awaiting delivery', async () => {
    let resolveSend;
    const view = mount(createState(), {
      respond(method) { return method === METHODS.send ? new Promise((resolve) => { resolveSend = resolve; }) : Promise.resolve({}); },
    });
    try {
      type(view.root, 'First message');
      act(() => view.root.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
      await flush();
      type(view.root, 'Next draft while reconnecting');
      await act(async () => { resolveSend({}); await flush(); });
      expect(view.root.querySelector('textarea').value).toBe('Next draft while reconnecting');
      expect(view.draftCache.get('thread-1').draft.draftText).toBe('Next draft while reconnecting');
    } finally { view.unmount(); }
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

  test('dismisses composer menus outside their holder for touch and mouse', async () => {
    const view = mount();
    try {
      for (const pointerType of ['touch', 'mouse']) {
        for (const selector of ['[aria-label="Composer actions"]', '.permission-control > button', '.model-chip']) {
          act(() => view.root.querySelector(selector).click());
          const menu = view.root.querySelector('.composer-menu');
          expect(menu).not.toBeNull();
          act(() => menu.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType })));
          expect(view.root.querySelector('.composer-menu')).not.toBeNull();
          act(() => view.root.querySelector('textarea').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType })));
          expect(view.root.querySelector('.composer-menu')).toBeNull();
          act(() => view.root.querySelector(selector).click());
          act(() => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType })));
          expect(view.root.querySelector('.composer-menu')).toBeNull();
        }
      }
    } finally { view.unmount(); }
  });

  test('does not reopen suggestions after clearing, Escape, or an outside touch during a request', async () => {
    let resolveCommands;
    const view = mount(createState(), { respond: (method) => method === METHODS.commands
      ? new Promise((resolve) => { resolveCommands = resolve; }) : Promise.resolve({}) });
    try {
      for (const action of ['clear', 'escape', 'outside']) {
        type(view.root, '/test');
        await wait(150);
        expect(resolveCommands).toBeFunction();
        if (action === 'clear') type(view.root, '');
        else if (action === 'escape') act(() => view.root.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        else act(() => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })));
        await act(async () => resolveCommands([{ type: 'workflow', name: 'test' }]));
        expect(view.root.querySelector('.command-picker')).toBeNull();
        type(view.root, '/tes');
        await wait(150);
        await act(async () => resolveCommands([{ type: 'workflow', name: 'test' }]));
        expect(view.root.querySelector('.command-picker')).not.toBeNull();
        act(() => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })));
        expect(view.root.querySelector('.command-picker')).toBeNull();
      }
    } finally { view.unmount(); }
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
