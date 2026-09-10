import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { ATTACHMENT_CHUNK_SIZE, METHODS, normalizeNoteAttachmentChunk, normalizeNoteUploadResult } from '../src/rpc/contracts.js';

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

let NotesPanel;

beforeAll(async () => {
  ({ NotesPanel } = await import('../src/components/NotesPanel.jsx'));
});

const mounted = [];

afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  document.body.replaceChildren();
});

const FOLDER = 'C:\\Code\\avi';
const fullDiscovery = { appVersion: 'test', apiVersion: 1, versions: { rpc: 1 }, methods: Object.values(METHODS) };

function discoveryWithout(...names) {
  const excluded = names.map((name) => METHODS[name]);
  return { ...fullDiscovery, methods: Object.values(METHODS).filter((method) => !excluded.includes(method)) };
}

function listFixture(overrides = {}) {
  return { id: 'l1', name: 'Inbox', folderPath: FOLDER, archived: false, orderBy: 'urgency', ...overrides };
}

function noteFixture(overrides = {}) {
  return {
    id: 'n1', listId: 'l1', title: 'First note', description: 'Details', priority: 'none',
    dueAt: null, done: false, archived: false, subtasks: [], attachments: [], ...overrides,
  };
}

function mountNotes(options = {}) {
  const { lists = [listFixture()], notes = { l1: [noteFixture()] }, discovery = fullDiscovery, folderPath = FOLDER, respond } = options;
  const calls = [];
  const client = {
    request(method, params) {
      calls.push({ method, params });
      if (respond) return respond(method, params, { lists, notes });
      if (method === METHODS.noteLists) return Promise.resolve(lists);
      if (method === METHODS.searchNotes) {
        const items = notes[params.listIds[0]] ?? [];
        return Promise.resolve({ notes: items, total: items.length });
      }
      return Promise.resolve({});
    },
  };
  const root = document.createElement('div');
  document.body.append(root);
  act(() => render(h(NotesPanel, { client, discovery, folderPath }), root));
  const view = { root, calls, client, unmount() { act(() => render(null, root)); } };
  mounted.push(view);
  return view;
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

function buttonWithText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.trim().includes(text));
}

function dialog() {
  return document.body.querySelector('[role="dialog"]');
}

function setInput(element, value) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function setSelect(element, value) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function setDate(element, value) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function filterSelect(root, labelText) {
  const label = [...root.querySelectorAll('.notes-filters label')].find((item) => item.textContent.trim().startsWith(labelText));
  return label.querySelector('select, input');
}

async function submitDialog() {
  act(() => dialog().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await flush();
}

describe('NotesPanel', () => {
  test('stays inert with an explanatory message when notes RPC is undiscovered', async () => {
    for (const missing of [['searchNotes'], ['noteLists']]) {
      const view = mountNotes({ discovery: discoveryWithout(...missing) });
      expect(view.root.querySelector('.notes-panel')).toBeNull();
      expect(view.root.textContent).toContain('Notes is not available on this Avi instance.');
      await wait(300);
      expect(view.calls).toHaveLength(0);
    }
  });

  test('disables mutations missing from discovery without blocking reads', async () => {
    const view = mountNotes({ discovery: discoveryWithout('saveNoteList', 'saveNote') });
    await wait(350);
    expect(view.root.textContent).toContain('First note');
    expect(view.root.querySelector('[aria-label="New note list"]').disabled).toBe(true);
    expect(view.root.querySelector('input[aria-label="Complete First note"]').disabled).toBe(true);
  });

  test('loads scoped lists and notes with the default filters', async () => {
    const view = mountNotes();
    expect(view.root.textContent).toContain('Loading notes');
    await wait(350);
    expect(view.calls.find((call) => call.method === METHODS.noteLists)?.params).toEqual({ folderPath: FOLDER, archived: null });
    expect(view.calls.find((call) => call.method === METHODS.searchNotes)?.params).toEqual({
      listIds: ['l1'], query: '', archived: false, orderBy: 'urgency', limit: 5000,
    });
    expect(view.root.textContent).toContain('Inbox');
    expect(view.root.textContent).toContain('First note');
  });

  test('sends search text, done state, priority, and the due window in search payloads', async () => {
    const view = mountNotes();
    await wait(350);
    setInput(view.root.querySelector('input[aria-label="Search notes"]'), 'deploy');
    setSelect(filterSelect(view.root, 'Status'), 'done');
    setSelect(filterSelect(view.root, 'Priority'), 'high');
    setDate(filterSelect(view.root, 'From'), '2026-09-01');
    setDate(filterSelect(view.root, 'Through'), '2026-09-10');
    await wait(350);
    const searches = view.calls.filter((call) => call.method === METHODS.searchNotes);
    expect(searches.at(-1).params).toMatchObject({
      listIds: ['l1'],
      query: 'deploy',
      archived: false,
      done: true,
      priority: 'high',
      dueAfter: new Date('2026-09-01T00:00:00').toISOString(),
      dueBefore: new Date('2026-09-10T23:59:59.999').toISOString(),
    });
  });

  test('requests archived notes across all folders when scoped that way', async () => {
    const view = mountNotes();
    await wait(350);
    setSelect(filterSelect(view.root, 'Status'), 'archived');
    const scope = view.root.querySelector('.notes-check input');
    act(() => {
      scope.checked = true;
      scope.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await wait(350);
    expect(view.calls.filter((call) => call.method === METHODS.noteLists).at(-1).params).toEqual({ archived: null });
    expect(view.calls.filter((call) => call.method === METHODS.searchNotes).at(-1).params.archived).toBeNull();
  });

  test('completes and archives a note through notes:save', async () => {
    const view = mountNotes();
    await wait(350);
    const box = view.root.querySelector('input[aria-label="Complete First note"]');
    act(() => {
      box.checked = true;
      box.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flush();
    act(() => buttonWithText(view.root, 'Archive note').click());
    await flush();
    const saves = view.calls.filter((call) => call.method === METHODS.saveNote).map((call) => call.params);
    expect(saves).toContainEqual({ id: 'n1', done: true });
    expect(saves).toContainEqual({ id: 'n1', archived: true });
  });

  test('creates lists and notes with scoped payloads', async () => {
    const view = mountNotes();
    await wait(350);
    act(() => view.root.querySelector('[aria-label="New note list"]').click());
    expect(dialog().querySelector('h2').textContent).toBe('Note list');
    setInput(dialog().querySelector('input[required]'), 'Ideas');
    await submitDialog();
    expect(view.calls.find((call) => call.method === METHODS.saveNoteList)?.params).toMatchObject({ name: 'Ideas', folderPath: FOLDER });
    act(() => buttonWithText(view.root, 'New note').click());
    expect(dialog().querySelector('h2').textContent).toBe('Note');
    setInput(dialog().querySelector('input[required]'), 'Second note');
    await submitDialog();
    const saves = view.calls.filter((call) => call.method === METHODS.saveNote);
    expect(saves.at(-1).params).toMatchObject({
      listId: 'l1', title: 'Second note', description: '', priority: 'none', dueAt: null, subtasks: [],
    });
  });

  test('moves notes within a list and lists across the panel through notes:reorder', async () => {
    const view = mountNotes({
      lists: [listFixture(), listFixture({ id: 'l2', name: 'Later' })],
      notes: { l1: [noteFixture(), noteFixture({ id: 'n2', title: 'Second note' })], l2: [] },
    });
    await wait(350);
    const noteDown = [...view.root.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Move note down');
    expect(noteDown).toHaveLength(2);
    expect(noteDown[1].disabled).toBe(true);
    act(() => noteDown[0].click());
    await flush();
    const listDown = [...view.root.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Move list down');
    act(() => listDown[0].click());
    await flush();
    const reorders = view.calls.filter((call) => call.method === METHODS.reorderNotes);
    expect(reorders[0].params).toEqual({ ids: ['n2', 'n1'], listId: 'l1' });
    expect(reorders[1].params).toEqual({ ids: ['l2', 'l1'] });
  });

  test('reorders subtasks locally and saves the visible order', async () => {
    const view = mountNotes({
      notes: { l1: [noteFixture({ subtasks: [{ id: 's1', text: 'Alpha', done: false }, { id: 's2', text: 'Beta', done: false }] })] },
    });
    await wait(350);
    act(() => buttonWithText(view.root, 'Edit note, deadline and subtasks').click());
    expect(dialog().querySelector('input[aria-label="Subtask 1"]').value).toBe('Alpha');
    act(() => dialog().querySelector('[aria-label="Move subtask 2 up"]').click());
    expect(dialog().querySelector('input[aria-label="Subtask 1"]').value).toBe('Beta');
    expect(dialog().querySelector('input[aria-label="Subtask 2"]').value).toBe('Alpha');
    await submitDialog();
    const save = view.calls.find((call) => call.method === METHODS.saveNote);
    expect(save.params.subtasks.map((task) => task.text)).toEqual(['Beta', 'Alpha']);
  });

  test('confirms permanent deletion with an explicit archived-only scope', async () => {
    const view = mountNotes();
    await wait(350);
    act(() => buttonWithText(view.root, 'Delete list').click());
    expect(dialog().querySelector('h2').textContent).toBe('Delete notes');
    expect(dialog().textContent).toContain('the list and all notes in');
    await submitDialog();
    const deletes = view.calls.filter((call) => call.method === METHODS.deleteNoteList);
    expect(deletes[0].params).toEqual({ id: 'l1', archivedOnly: false });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => buttonWithText(view.root, 'Delete archived notes').click());
    expect(dialog().textContent).toContain('all archived notes in');
    await submitDialog();
    expect(view.calls.filter((call) => call.method === METHODS.deleteNoteList).at(-1).params).toEqual({ id: 'l1', archivedOnly: true });
  });

  test('clears polling timers on unmount and issues no further requests', async () => {
    const createdIntervals = [];
    const clearedIntervals = [];
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    globalThis.setInterval = (...args) => {
      const id = originalSet(...args);
      createdIntervals.push(id);
      return id;
    };
    globalThis.clearInterval = (id) => {
      clearedIntervals.push(id);
      return originalClear(id);
    };
    try {
      const view = mountNotes();
      expect(createdIntervals.length).toBeGreaterThan(0);
      view.unmount();
      for (const id of createdIntervals) expect(clearedIntervals).toContain(id);
      await wait(350);
      expect(view.calls).toHaveLength(0);
    } finally {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    }
  });

  test('uploads note attachments in chunks and refreshes the editor list', async () => {
    const view = mountNotes({
      notes: { l1: [noteFixture({ id: 'n1', attachments: [] })] },
      respond(method, params) {
        if (method === METHODS.noteLists) return Promise.resolve([listFixture()]);
        if (method === METHODS.searchNotes) return Promise.resolve({ notes: [noteFixture({ id: 'n1', attachments: [] })], total: 1 });
        if (method === METHODS.uploadNoteAttachment) {
          const offset = params.offset + atob(params.data).length;
          return Promise.resolve({ uploadId: 'u9', offset, complete: offset === 5, note: { attachments: [{ id: 'f1', name: 'a.txt', size: 5 }] } });
        }
        return Promise.resolve({});
      },
    });
    await wait(350);
    act(() => buttonWithText(view.root, 'Manage attachments').click());
    const input = dialog().querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['hello'], 'a.txt', { type: 'text/plain' })] });
    await act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(view.calls.find((call) => call.method === METHODS.uploadNoteAttachment)?.params).toMatchObject({
      id: 'n1', name: 'a.txt', size: 5, offset: 0,
    });
    expect(dialog().textContent).toContain('a.txt');
  });

  test('downloads note attachments through bounded chunk reads', async () => {
    const created = [];
    const clicks = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const anchorProto = window.HTMLAnchorElement.prototype;
    const originalClick = anchorProto.click;
    URL.createObjectURL = (blob) => {
      created.push(blob);
      return 'blob:mock-note';
    };
    URL.revokeObjectURL = () => {};
    anchorProto.click = function () {
      clicks.push({ href: this.href, download: this.download });
    };
    try {
      const view = mountNotes({
        notes: { l1: [noteFixture({ attachments: [{ id: 'f1', name: 'a.txt', size: 5 }] })] },
        respond(method, params) {
          if (method === METHODS.noteLists) return Promise.resolve([listFixture()]);
          if (method === METHODS.searchNotes) return Promise.resolve({ notes: [noteFixture({ attachments: [{ id: 'f1', name: 'a.txt', size: 5 }] })], total: 1 });
          if (method === METHODS.readNoteAttachment) {
            expect(params).toMatchObject({ id: 'n1', attachmentId: 'f1', offset: 0 });
            return Promise.resolve({ data: btoa('hello'), offset: 0, size: 5, bytesRead: 5 });
          }
          return Promise.resolve({});
        },
      });
      await wait(350);
      act(() => buttonWithText(view.root, 'Manage attachments').click());
      await act(async () => {
        dialog().querySelector('[aria-label="Download a.txt"]').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(view.calls.find((call) => call.method === METHODS.readNoteAttachment)?.params).toMatchObject({
        id: 'n1', attachmentId: 'f1', offset: 0,
      });
      expect(created).toHaveLength(1);
      expect(created[0].size).toBe(5);
      expect(clicks).toEqual([{ href: 'blob:mock-note', download: 'a.txt' }]);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      anchorProto.click = originalClick;
    }
  });

  test('accepts a valid attachment chunk and upload result at binary chunk limits', () => {
    expect(ATTACHMENT_CHUNK_SIZE).toBe(262144);
    const bytes = normalizeNoteAttachmentChunk({ data: btoa('hello'), offset: 0, size: 5, bytesRead: 5 }, { offset: 0, size: 5 });
    expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
    const full = new Uint8Array(ATTACHMENT_CHUNK_SIZE);
    let binary = '';
    for (const byte of full) binary += String.fromCharCode(byte);
    expect(normalizeNoteAttachmentChunk({ data: btoa(binary), offset: 0, size: ATTACHMENT_CHUNK_SIZE, bytesRead: ATTACHMENT_CHUNK_SIZE }, { offset: 0, size: ATTACHMENT_CHUNK_SIZE }).length).toBe(ATTACHMENT_CHUNK_SIZE);
    const result = normalizeNoteUploadResult({ uploadId: 'u9', offset: 5, complete: false, note: {} }, { offset: 0, length: 5, size: 10 });
    expect(result.uploadId).toBe('u9');
  });

  test('rejects mismatched chunk offsets, byte counts, sizes, and completion', () => {
    expect(() => normalizeNoteAttachmentChunk({ data: btoa('hello'), offset: 5, size: 5, bytesRead: 5 }, { offset: 0, size: 5 })).toThrow('Avi returned an invalid note attachment chunk.');
    expect(() => normalizeNoteAttachmentChunk({ data: btoa('hello'), offset: 0, size: 6, bytesRead: 5 }, { offset: 0, size: 5 })).toThrow('Avi returned an invalid note attachment chunk.');
    expect(() => normalizeNoteAttachmentChunk({ data: btoa('hello'), offset: 0, size: 5, bytesRead: 4 }, { offset: 0, size: 5 })).toThrow('Avi returned an invalid note attachment chunk.');
    expect(() => normalizeNoteAttachmentChunk({ data: btoa(''), offset: 0, size: 5, bytesRead: 0 }, { offset: 0, size: 5 })).toThrow('Avi returned an invalid note attachment chunk.');
    expect(() => normalizeNoteUploadResult({ uploadId: 'u9', offset: 4, complete: false, note: {} }, { offset: 0, length: 5, size: 10 })).toThrow('Avi returned an invalid note upload result.');
    expect(() => normalizeNoteUploadResult({ uploadId: 'u9', offset: 10, complete: false, note: { attachments: [] } }, { offset: 5, length: 5, size: 10 })).toThrow('Avi returned an invalid note upload result.');
    expect(() => normalizeNoteUploadResult({ uploadId: 'u9', offset: 10, complete: true, note: {} }, { offset: 5, length: 5, size: 10 })).toThrow('Avi returned an invalid note upload result.');
  });
});
