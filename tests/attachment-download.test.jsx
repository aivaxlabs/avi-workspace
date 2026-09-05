import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
  URL: window.URL,
  Blob: window.Blob,
});

let RichMessage;

beforeAll(async () => {
  ({ RichMessage } = await import('../src/components/RichMessage.jsx'));
});

const FULL_DISCOVERY = { methods: ['attachments:read', 'files:diff', 'conversations:tool-call-details'] };

const createdUrls = [];
const revokedUrls = [];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  createdUrls.length = 0;
  revokedUrls.length = 0;
  URL.createObjectURL = (blob) => { const url = originalCreateObjectURL(blob); createdUrls.push(url); return url; };
  URL.revokeObjectURL = (url) => { revokedUrls.push(url); return originalRevokeObjectURL(url); };
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  document.body.replaceChildren();
});

function createChunkClient() {
  const requests = [];
  const resolvers = [];
  return {
    requests,
    resolvers,
    client: {
      request(method, params) {
        requests.push({ method, params });
        return new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
      },
    },
  };
}

function renderMessage(message, client, discovery = FULL_DISCOVERY) {
  const root = document.createElement('div');
  document.body.append(root);
  act(() => render(h(RichMessage, { message, client, discovery }), root));
  return root;
}

function fileMessage(overrides = {}) {
  return {
    id: 'msg-1',
    role: 'user',
    status: 'sent',
    content: '',
    attachments: [{ id: 'file-1', kind: 'file', name: 'notes.txt', mime: 'text/plain', size: 11, ...overrides }],
  };
}

describe('RichMessage attachment download', () => {
  test('keeps attachment and diff actions disabled without advertised methods and sends no requests', () => {
    let requests = 0;
    const client = { request() { requests += 1; return Promise.resolve({ data: '', mime: 'text/plain', hasMore: false }); } };
    const message = {
      id: 'gated',
      role: 'user',
      status: 'sent',
      content: '',
      attachments: [
        { id: 'file-1', kind: 'file', name: 'notes.txt', mime: 'text/plain', size: 11 },
        { id: 'img-1', kind: 'image_url', name: 'screen.png', mime: 'image/png' },
        { id: 'ref-1', kind: 'file_reference', name: 'remote.md', path: 'C:/docs/remote.md' },
      ],
    };
    const root = renderMessage(message, client, { methods: [] });

    const load = root.querySelector('[aria-label="Load notes.txt"]');
    expect(load.disabled).toBeTrue();
    expect(load.title).toBe('Attachment loading is not available on this Avi instance.');
    const image = root.querySelector('.user-attachment-image');
    expect(image.disabled).toBeTrue();
    expect(image.title).toBe('Attachment loading is not available on this Avi instance.');
    const diff = root.querySelector('[aria-label="View diff for remote.md"]');
    expect(diff.disabled).toBeTrue();
    expect(diff.title).toBe('Diff viewing is not available on this Avi instance.');

    act(() => load.click());
    act(() => image.click());
    act(() => diff.click());
    expect(requests).toBe(0);
  });

  test('blocks loads for attachments above the 25 MiB limit without requests', () => {
    let requests = 0;
    const client = { request() { requests += 1; return Promise.resolve({ data: '', mime: 'text/plain', hasMore: false }); } };
    const root = renderMessage(fileMessage({ size: 25 * 1024 * 1024 + 1 }), client);

    const load = root.querySelector('[aria-label="Load notes.txt"]');
    expect(load.disabled).toBeTrue();
    expect(load.title).toBe('Attachment exceeds the 25 MiB remote load limit.');
    act(() => load.click());
    expect(requests).toBe(0);
  });

  test('streams chunks following the cursor with loaded bytes and completes into a blob link', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const root = renderMessage(fileMessage(), client);

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    expect(requests).toEqual([{ method: 'attachments:read', params: { messageId: 'msg-1', attachmentId: 'file-1', offset: 0, limit: 262144 } }]);

    await act(async () => { resolvers[0].resolve({ data: btoa('hello'), mime: 'text/plain', name: 'notes.txt', cursor: 5, hasMore: true }); await Promise.resolve(); });
    expect(root.querySelector('[role="status"]').textContent).toContain('5 B / 11 B');
    expect(root.querySelector('[aria-label="Cancel loading notes.txt"]')).not.toBeNull();
    expect(requests[1].params.offset).toBe(5);

    await act(async () => { resolvers[1].resolve({ data: btoa(' world'), mime: 'text/plain', hasMore: false }); await Promise.resolve(); });
    expect(root.querySelector('[role="status"]')).toBeNull();
    const link = root.querySelector('[aria-label="Download notes.txt"]');
    expect(link.getAttribute('href')).toMatch(/^blob:/);
    expect(createdUrls).toHaveLength(1);
  });

  test('cancel stops further chunk requests and keeps the attachment reloadable', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const root = renderMessage(fileMessage(), client);

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    await act(async () => { resolvers[0].resolve({ data: btoa('hello'), mime: 'text/plain', cursor: 5, hasMore: true }); await Promise.resolve(); });
    expect(requests).toHaveLength(2);

    act(() => root.querySelector('[aria-label="Cancel loading notes.txt"]').click());
    await act(async () => { resolvers[1].resolve({ data: btoa(' world'), mime: 'text/plain', hasMore: false }); await Promise.resolve(); });

    expect(requests).toHaveLength(2);
    expect(root.querySelector('[aria-label="Download notes.txt"]')).toBeNull();
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(createdUrls).toHaveLength(0);
    expect(root.querySelector('[aria-label="Load notes.txt"]').disabled).toBeFalse();

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    expect(requests).toHaveLength(3);
    expect(requests[2].params.offset).toBe(0);
  });

  test('rejects a non-advancing cursor instead of looping', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const root = renderMessage(fileMessage(), client);

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    await act(async () => { resolvers[0].resolve({ data: btoa('hello'), mime: 'text/plain', cursor: 0, hasMore: true }); await Promise.resolve(); });

    expect(requests).toHaveLength(1);
    expect(root.querySelector('[role="alert"]').textContent).toContain('Avi attachment cursor did not advance correctly.');
    expect(root.querySelector('[aria-label="Download notes.txt"]')).toBeNull();
  });

  test('rejects empty progress chunks instead of looping', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const root = renderMessage(fileMessage(), client);

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    await act(async () => { resolvers[0].resolve({ data: '', mime: 'text/plain', cursor: 5, hasMore: true }); await Promise.resolve(); });

    expect(requests).toHaveLength(1);
    expect(root.querySelector('[role="alert"]').textContent).toContain('Avi returned an empty attachment chunk.');
  });

  test('stops mid-stream when the total load would exceed 25 MiB', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const root = renderMessage(fileMessage({ size: null }), client);

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    await act(async () => { resolvers[0].resolve({ data: 'A'.repeat(Math.ceil((25 * 1024 * 1024 + 1) / 3) * 4), mime: 'text/plain', hasMore: false }); await Promise.resolve(); });

    expect(requests).toHaveLength(1);
    expect(root.querySelector('[role="alert"]').textContent).toContain('Attachment exceeds the 25 MiB remote load limit.');
    expect(createdUrls).toHaveLength(0);
  });

  test('unmount during a pending read ignores the inflight chunk and sends no more requests', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const root = renderMessage(fileMessage(), client);

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    render(null, root);
    await act(async () => { resolvers[0].resolve({ data: btoa('hello'), mime: 'text/plain', cursor: 5, hasMore: true }); await Promise.resolve(); });

    expect(requests).toHaveLength(1);
    expect(createdUrls).toHaveLength(0);
    expect(revokedUrls).toHaveLength(0);
  });

  test('revokes the blob URL when the loaded attachment unmounts', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const root = renderMessage(fileMessage(), client);

    act(() => root.querySelector('[aria-label="Load notes.txt"]').click());
    await act(async () => { resolvers[0].resolve({ data: btoa('hello'), mime: 'text/plain', cursor: 5, hasMore: true }); await Promise.resolve(); });
    await act(async () => { resolvers[1].resolve({ data: btoa(' world'), mime: 'text/plain', hasMore: false }); await Promise.resolve(); });

    const href = root.querySelector('[aria-label="Download notes.txt"]').getAttribute('href');
    render(null, root);
    expect(revokedUrls).toEqual([href]);
  });

  test('loads advertised diffs into the diff block', async () => {
    const { client, requests, resolvers } = createChunkClient();
    const message = {
      id: 'msg-2',
      role: 'user',
      status: 'sent',
      content: '',
      attachments: [{ id: 'ref-1', kind: 'file_reference', name: 'remote.md', path: 'C:/docs/remote.md' }],
    };
    const root = renderMessage(message, client);

    act(() => root.querySelector('[aria-label="View diff for remote.md"]').click());
    expect(requests[0]).toEqual({ method: 'files:diff', params: { filePath: 'C:/docs/remote.md' } });
    await act(async () => { resolvers[0].resolve({ diff: '+added line\n-removed line' }); await Promise.resolve(); });

    const block = root.querySelector('.diff-block');
    expect(block).not.toBeNull();
    expect(block.textContent).toContain('+added line');
    expect(block.textContent).toContain('-removed line');
  });

  test('opens the image lightbox with the shared modal focus and closes on Escape', async () => {
    const { client, resolvers } = createChunkClient();
    const message = {
      id: 'msg-3',
      role: 'user',
      status: 'sent',
      content: '',
      attachments: [{ id: 'img-1', kind: 'image_url', name: 'screen.png', mime: 'image/png' }],
    };
    const root = renderMessage(message, client);

    act(() => root.querySelector('[aria-label="Load preview for screen.png"]').click());
    await act(async () => { resolvers[0].resolve({ data: btoa('image-bytes'), mime: 'image/png', hasMore: false }); await Promise.resolve(); });

    act(() => root.querySelector('[aria-label="Open screen.png"]').click());
    const dialog = root.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-label')).toBe('Image preview: screen.png');
    expect(document.activeElement.getAttribute('aria-label')).toBe('Close image preview');

    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  test('shows a disabled reason for tool details without advertised method and sends no requests', () => {
    let requests = 0;
    const client = { request() { requests += 1; return Promise.resolve({}); } };
    const message = {
      id: 'msg-4',
      role: 'assistant',
      status: 'completed',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:02.000Z',
      segments: [{ id: 'tool-1', messageId: 'msg-4', type: 'tool-call', name: 'read_file', detailsAvailable: true, hasResult: true }],
    };
    const root = renderMessage(message, client, { methods: [] });

    // Tool-only completed messages render the thinking group directly in the timeline (no worked summary).
    act(() => root.querySelector('.thinking-summary').click());
    act(() => root.querySelector('.tool-line').click());

    expect(root.textContent).toContain('Tool details are not available on this Avi instance.');
    expect(requests).toBe(0);
  });
});
