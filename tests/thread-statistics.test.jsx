import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { METHODS } from '../src/rpc/contracts.js';
import { summarizeThreadStatistics } from '../src/lib/thread-statistics.js';

const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
});

let ThreadStatistics;
let root;

beforeAll(async () => {
  ({ ThreadStatistics } = await import('../src/components/ThreadStatistics.jsx'));
});

afterEach(() => {
  if (root) act(() => render(null, root));
  document.body.replaceChildren();
  root = null;
});

const discovery = { versions: { rpc: 1 }, methods: [METHODS.chatStatistics] };

const statistics = {
  latency: {
    firstToken: { p50: 900, p95: 1_800, p99: 2_500, samples: 10 },
    connection: { p50: 120, p95: 300, p99: 400, samples: 10 },
  },
  tokensPerSecond: { p50: 42.5, p95: 60, p99: 70, samples: 8 },
  tokens: { input: 12_000, cached: 5_400, output: 2_300, reasoning: 276, total: 14_300, cachedRatio: 0.45, reasoningRatio: 0.12 },
  requests: { count: 12, errors: 1 },
  tools: { calls: 34, invocationErrors: 2, otherErrors: 1 },
};

function mount(props) {
  root = document.createElement('div');
  document.body.append(root);
  act(() => render(h(ThreadStatistics, props), root));
}

describe('thread statistics', () => {
  test('formats percentiles, tokens, requests, and tool failures', () => {
    expect(summarizeThreadStatistics(statistics)).toEqual([
      { id: 'first-token', label: 'First token', value: '900 ms · p95 1.8 s', detail: null },
      { id: 'connection', label: 'Connection', value: '120 ms · p95 300 ms', detail: null },
      { id: 'speed', label: 'Output speed', value: '43 tok/s · p95 60 tok/s', detail: null },
      { id: 'tokens', label: 'Tokens', value: '14.3K', detail: 'in 12K · out 2.3K · cached 45% · reasoning 12%' },
      { id: 'requests', label: 'Requests', value: '12', detail: '1 failed' },
      { id: 'tools', label: 'Tool calls', value: '34', detail: '3 failed' },
    ]);
    expect(summarizeThreadStatistics({})).toEqual([
      { id: 'first-token', label: 'First token', value: '—', detail: null },
      { id: 'connection', label: 'Connection', value: '—', detail: null },
      { id: 'speed', label: 'Output speed', value: '—', detail: null },
      { id: 'tokens', label: 'Tokens', value: '0', detail: 'in 0 · out 0' },
      { id: 'requests', label: 'Requests', value: '0', detail: '0 failed' },
      { id: 'tools', label: 'Tool calls', value: '0', detail: '0 failed' },
    ]);
  });

  test('loads chat:statistics, renders the rows, and refreshes on demand', async () => {
    const calls = [];
    mount({ client: { request: (method) => { calls.push(method); return Promise.resolve(statistics); } }, discovery });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls).toEqual([METHODS.chatStatistics]);
    const rows = [...root.querySelectorAll('.statistics-list > div')];
    expect(rows.map((row) => row.querySelector('strong').textContent)).toEqual(['First token', 'Connection', 'Output speed', 'Tokens', 'Requests', 'Tool calls']);
    expect(rows[3].querySelector('b').textContent).toBe('14.3K');
    expect(rows[3].querySelector('small').textContent).toContain('cached 45%');

    act(() => root.querySelector('.statistics-list header button').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(calls).toHaveLength(2);
  });

  test('reports failures and stays honest when the method is not advertised', async () => {
    mount({ client: { request: () => Promise.reject(new Error('Statistics are unavailable.')) }, discovery });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(root.querySelector('.inline-error').textContent).toContain('Statistics are unavailable.');

    act(() => render(null, root));
    mount({ client: { request: () => Promise.resolve(statistics) }, discovery: { versions: { rpc: 1 }, methods: [] } });
    expect(root.querySelector('.statistics-list')).toBeNull();
    expect(root.textContent).toContain('does not report thread statistics');
  });
});