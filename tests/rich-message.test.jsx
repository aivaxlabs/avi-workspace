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
});

let RichMessage;

beforeAll(async () => {
  ({ RichMessage } = await import('../src/components/RichMessage.jsx'));
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('RichMessage', () => {
  test('renders Desktop-style attachment pills and media thumbnails outside the user bubble', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const message = {
      id: 'user-attachments',
      role: 'user',
      status: 'sent',
      content: 'Inspect these attachments.',
      attachments: [
        { id: 'workflow', kind: 'context_marker', markerType: 'workflow', name: '/init' },
        { id: 'document', kind: 'file', name: 'report.pdf', mime: 'application/pdf', size: 2048 },
        { id: 'image', kind: 'image_url', name: 'screen.png', mime: 'image/png' },
      ],
    };

    act(() => render(h(RichMessage, { message, client: { request() {} } }), root));

    const bubble = root.querySelector('.user-bubble');
    const attachments = root.querySelector('.attachment-list');
    expect(bubble.textContent).toContain('Inspect these attachments.');
    expect(bubble.contains(attachments)).toBeFalse();
    expect(attachments.getAttribute('aria-label')).toBe('Message attachments');
    expect(attachments.querySelector('.attachment-pill.context-marker').textContent).toContain('/init');
    expect(attachments.querySelector('.attachment-pill.context-marker > i').className).toContain('ri-flow-chart');
    expect(attachments.querySelector('.attachment-pill:not(.context-marker) .attachment-name').textContent).toBe('report.pdf');
    expect(attachments.querySelector('.attachment-pill:not(.context-marker) small').textContent).toBe('2.0 KB');
    expect(attachments.querySelector('[aria-label="Load report.pdf"]')).not.toBeNull();
    expect(attachments.querySelector('.user-attachment-image.attachment-placeholder').getAttribute('aria-label')).toBe('Load preview for screen.png');
  });

  test('hydrates projected tool details without marking completed calls as pending', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const calls = [];
    const message = {
      id: 'assistant-projected',
      role: 'assistant',
      status: 'completed',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:02.000Z',
      segments: [
        { id: 'projected-completed', messageId: 'assistant-projected', type: 'tool-call', name: 'read_file', detailsAvailable: true, hasResult: true, status: 'completed' },
        { id: 'projected-pending', messageId: 'assistant-projected', type: 'tool-call', name: 'run_in_terminal', detailsAvailable: true, hasResult: false, status: 'running' },
      ],
    };
    let resolveDetails;
    const client = { request(method, params) {
      calls.push({ method, params });
      return new Promise((resolve) => { resolveDetails = resolve; });
    } };

    act(() => render(h(RichMessage, { message, client }), root));
    act(() => root.querySelector('.thinking-summary').click());

    const tools = [...root.querySelectorAll('.tool-line')];
    const completed = tools.find((button) => button.textContent.includes('read_file'));
    const pending = tools.find((button) => button.textContent.includes('run_in_terminal'));
    expect(completed.querySelector('[aria-label="Waiting for tool output"]')).toBeNull();
    expect(pending.querySelector('[aria-label="Waiting for tool output"]')).not.toBeNull();

    act(() => completed.click());
    expect(completed.closest('.tool-entry').textContent).toContain('Loading tool details...');
    expect(calls).toEqual([{ method: 'conversations:tool-call-details', params: { messageId: 'assistant-projected', segmentId: 'projected-completed' } }]);

    await act(async () => resolveDetails({ argumentsText: '{"path":"README.md"}', hasResult: true, resultText: 'Contents', mediaContent: [] }));
    expect(completed.closest('.tool-entry').textContent).toContain('"path": "README.md"');
    expect(completed.closest('.tool-entry').textContent).toContain('Contents');
  });

  test('shows lazy detail errors and retries after reopening', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    let requests = 0;
    let rejectDetails;
    const client = { request() {
      requests += 1;
      return new Promise((_resolve, reject) => { rejectDetails = reject; });
    } };
    const message = {
      id: 'assistant-error', role: 'assistant', status: 'completed',
      segments: [{ id: 'tool-error', messageId: 'assistant-error', type: 'tool-call', name: 'read_file', detailsAvailable: true, hasResult: true }],
    };

    act(() => render(h(RichMessage, { message, client }), root));
    act(() => root.querySelector('.thinking-summary').click());
    const tool = root.querySelector('.tool-line');
    act(() => tool.click());
    await act(async () => { rejectDetails(new Error('Details unavailable')); await Promise.resolve(); });
    expect(tool.closest('.tool-entry').querySelector('[role="alert"]').textContent).toContain('Details unavailable');
    act(() => tool.click());
    act(() => tool.click());
    expect(requests).toBe(2);
  });

  test('mounts and expands canonical reasoning and pending/completed/error tools', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      status: 'completed',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:14.000Z',
      content: 'Aggregate reasoning and answer must not render.',
      attachments: [],
      segments: [
        { id: 'reason-1', type: 'reasoning', text: 'Inspect the renderer.' },
        { id: 'tool-pending', type: 'tool-call', name: 'read_file', argumentsText: '{"path":"pending"}', status: 'running' },
        { id: 'tool-completed', type: 'tool-call', name: 'memory_search', argumentsText: '{"query":"timeline"}', resultText: '{"matches":2}', status: 'completed' },
        { id: 'tool-error', type: 'tool-call', name: 'run_in_terminal', argumentsText: '{"command":"false"}', resultText: 'Command failed.', status: 'error' },
        { id: 'content-middle', type: 'content', text: 'Intermediate finding.' },
        { id: 'tool-final', type: 'tool-call', name: 'read_file', argumentsText: '{}', resultText: 'Done.', status: 'completed' },
        { id: 'content-final', type: 'content', text: 'Final answer.' },
      ],
    };

    act(() => render(h(RichMessage, { message, client: { request() {} } }), root));

    expect(root.textContent).toContain('Worked for 14 seconds');
    expect(root.textContent).toContain('Final answer.');
    expect(root.textContent).not.toContain('Aggregate reasoning and answer must not render.');

    act(() => root.querySelector('.worked-summary').click());
    const thought = [...root.querySelectorAll('.thinking-summary')].find((button) => button.textContent.includes('Thought'));
    expect(thought.textContent).toContain('Thought, called 3 tools');
    expect(root.textContent).toContain('Intermediate finding.');

    act(() => thought.click());
    expect(root.querySelector('.thinking-group').classList.contains('has-tools')).toBeTrue();
    expect(root.querySelectorAll('.tool-line')).toHaveLength(3);
    expect(root.querySelector('[aria-label="Waiting for tool output"]')).not.toBeNull();
    expect(root.querySelector('.tool-entry.error').textContent).toContain('run_in_terminal');

    const completed = [...root.querySelectorAll('.tool-line')].find((button) => button.textContent.includes('memory_search'));
    act(() => completed.click());
    expect(completed.getAttribute('aria-expanded')).toBe('true');
    expect(completed.closest('.tool-entry').textContent).toContain('"matches": 2');
  });
});
