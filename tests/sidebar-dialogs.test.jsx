import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { useRef } from 'preact/hooks';
import { useModalFocus } from '../src/lib/use-modal-focus.js';

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

const clipboardWrites = [];
let clipboardShouldFail = false;
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: (text) => {
      if (clipboardShouldFail) return Promise.reject(new Error('Clipboard write was blocked.'));
      clipboardWrites.push(text);
      return Promise.resolve();
    },
  },
});

let ConversationSidebar;
let SidebarSearchDialog;
let root;

beforeAll(async () => {
  ({ ConversationSidebar } = await import('../src/components/ConversationSidebar.jsx'));
  ({ SidebarSearchDialog } = await import('../src/components/SidebarDialogs.jsx'));
});

afterEach(() => {
  if (root) act(() => render(null, root));
  document.body.replaceChildren();
  root = null;
  clipboardWrites.length = 0;
  clipboardShouldFail = false;
});

const conversations = [
  { id: 'working', title: 'Working thread', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi', updatedAt: '2026-09-01T12:00:00Z' },
];

function buttonWithText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.includes(text));
}

function flush() {
  return act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

function mountSidebar({ bots = [], props = {} } = {}) {
  const calls = [];
  root = document.createElement('div');
  document.body.append(root);
  act(() => render(h(ConversationSidebar, {
    collapsed: false,
    connection: { label: 'Test Avi' },
    conversations,
    folders: [],
    models: [{ id: 'model:one', name: 'Model One' }],
    bots,
    tags: [],
    sidebarStatus: {},
    schedulerSnooze: { active: false, mode: null, until: null },
    selectedId: 'working',
    onCreate() {},
    onExit() {},
    onSelect: (id) => calls.push(['select', id]),
    ...props,
  }), root));
  return calls;
}

function workingThreadRow() {
  return [...root.querySelectorAll('.thread-list > li')].find((li) => li.textContent.includes('Working thread'));
}

function ModalHarness({ open = true, onClose }) {
  const containerRef = useRef(null);
  useModalFocus({ open, containerRef, onClose });
  return <div ref={containerRef}><button type="button">Alpha</button><button type="button">Beta</button></div>;
}

describe('useModalFocus', () => {
  test('inerts siblings, contains Tab, handles Escape, and restores focus on unmount', () => {
    root = document.createElement('div');
    const outside = document.createElement('div');
    const outsideButton = document.createElement('button');
    outside.append(outsideButton);
    document.body.append(outside, root);
    act(() => outsideButton.focus());
    let closed = 0;
    act(() => render(h(ModalHarness, { onClose: () => { closed += 1; } }), root));
    expect(outside.hasAttribute('inert')).toBeTrue();
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement.textContent).toBe('Alpha');
    act(() => [...root.querySelectorAll('button')].at(-1).focus());
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement.textContent).toBe('Alpha');
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(closed).toBe(1);
    act(() => render(null, root));
    root = null;
    expect(outside.hasAttribute('inert')).toBeFalse();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(outsideButton);
  });

  test('keeps the topmost modal in charge of Escape and shares inert cleanup', () => {
    const outerRoot = document.createElement('div');
    const innerRoot = document.createElement('div');
    document.body.append(outerRoot, innerRoot);
    const closed = [];
    let outerRef;
    function Outer() {
      const containerRef = useRef(null);
      outerRef = containerRef;
      useModalFocus({ containerRef, onClose: () => closed.push('outer') });
      return <div ref={containerRef}><button type="button">Outer</button></div>;
    }
    function Inner() {
      const containerRef = useRef(null);
      useModalFocus({ containerRef, onClose: () => closed.push('inner') });
      return <div ref={containerRef}><button type="button">Inner</button></div>;
    }
    act(() => render(h(Outer), outerRoot));
    act(() => render(h(Inner), innerRoot));
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(closed).toEqual(['inner']);
    act(() => render(null, innerRoot));
    expect(outerRef.current?.querySelector('button')).not.toBeNull();
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(closed).toEqual(['inner', 'outer']);
    act(() => render(null, outerRoot));
    document.body.replaceChildren();
  });

  test('restores the original body overflow when modals close out of LIFO order', () => {
    document.body.style.overflow = '';
    const outerRoot = document.createElement('div');
    const innerRoot = document.createElement('div');
    document.body.append(outerRoot, innerRoot);
    function Outer() {
      const containerRef = useRef(null);
      useModalFocus({ containerRef, onClose() {} });
      return <div ref={containerRef}><button type="button">Outer</button></div>;
    }
    function Inner() {
      const containerRef = useRef(null);
      useModalFocus({ containerRef, onClose() {} });
      return <div ref={containerRef}><button type="button">Inner</button></div>;
    }
    act(() => render(h(Outer), outerRoot));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => render(h(Inner), innerRoot));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => render(null, outerRoot));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => render(null, innerRoot));
    expect(document.body.style.overflow).toBe('');
    document.body.replaceChildren();
  });

  test('skips focus targets inside hidden subtrees', () => {
    root = document.createElement('div');
    document.body.append(root);
    function HiddenHarness() {
      const containerRef = useRef(null);
      useModalFocus({ containerRef, onClose() {} });
      return (
        <div ref={containerRef}>
          <button type="button">First</button>
          <div style="display: none;"><button type="button">Concealed</button></div>
          <button type="button">Last</button>
        </div>
      );
    }
    act(() => render(h(HiddenHarness), root));
    expect(document.activeElement.textContent).toBe('First');
    act(() => [...root.querySelectorAll('button')].find((button) => button.textContent === 'Last').focus());
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement.textContent).toBe('First');
  });
});

describe('sidebar dialogs and actions', () => {
  test('rename uses a styled dialog with success feedback', async () => {
    const calls = mountSidebar({ props: { onRename: (item, title) => calls.push(['rename', item.id, title]) } });
    act(() => workingThreadRow().querySelector('.thread-menu').click());
    act(() => buttonWithText(document.body.querySelector('.conversation-menu'), 'Rename').click());
    const form = root.querySelector('.prompt-form');
    const input = form.querySelector('input');
    expect(input.value).toBe('Working thread');
    act(() => {
      input.value = 'Renamed thread';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    act(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(calls).toContainEqual(['rename', 'working', 'Renamed thread']);
    expect(root.querySelector('.sidebar-feedback.is-success').textContent).toContain('renamed');
    expect(root.querySelector('.prompt-form')).toBeNull();
  });

  test('delete confirmation blocks duplicate submits while busy', async () => {
    let resolveDelete;
    let deleteCalls = 0;
    mountSidebar({ props: { onDelete: () => new Promise((resolve) => { deleteCalls += 1; resolveDelete = resolve; }) } });
    act(() => workingThreadRow().querySelector('.thread-menu').click());
    act(() => buttonWithText(document.body.querySelector('.conversation-menu'), 'Delete chat').click());
    const confirmButton = buttonWithText(root.querySelector('.prompt-form'), 'Delete chat');
    act(() => confirmButton.click());
    await flush();
    expect(deleteCalls).toBe(1);
    expect(confirmButton.disabled).toBeTrue();
    act(() => confirmButton.click());
    await flush();
    expect(deleteCalls).toBe(1);
    await act(async () => { resolveDelete(); await flush(); });
    expect(root.querySelector('.prompt-form')).toBeNull();
    expect(root.querySelector('.sidebar-feedback').textContent).toContain('deleted');
  });

  test('failed delete keeps the dialog open with the error and can be cancelled', async () => {
    mountSidebar({ props: { onDelete: () => Promise.reject(new Error('Server refused the deletion.')) } });
    act(() => workingThreadRow().querySelector('.thread-menu').click());
    act(() => buttonWithText(document.body.querySelector('.conversation-menu'), 'Delete chat').click());
    act(() => buttonWithText(root.querySelector('.prompt-form'), 'Delete chat').click());
    await flush();
    expect(root.querySelector('.dialog-error').textContent).toContain('Server refused the deletion.');
    expect(root.querySelector('.prompt-form')).not.toBeNull();
    act(() => buttonWithText(root.querySelector('.prompt-form'), 'Cancel').click());
    expect(root.querySelector('.prompt-form')).toBeNull();
  });

  test('search failures are distinct from empty results and offer retry', async () => {
    let attempts = 0;
    root = document.createElement('div');
    document.body.append(root);
    act(() => render(h(SidebarSearchDialog, {
      onSearch: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('The Avi instance did not answer.'))
          : Promise.resolve([{ conversationId: 'review', title: 'Review thread', folderName: 'avi', content: 'Matched content' }]);
      },
      onSelect() {},
      onClose() {},
    }), root));
    act(() => {
      const input = root.querySelector('input');
      input.value = 'review';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(root.querySelector('.search-error').textContent).toContain('The Avi instance did not answer.');
    expect(root.querySelector('.search-results')).toBeNull();
    act(() => buttonWithText(root, 'Retry').click());
    await flush();
    expect(root.querySelector('.search-error')).toBeNull();
    expect(root.querySelector('.search-results').textContent).toContain('Matched content');
  });

  test('copy thread ID reports success and failure next to the sidebar', async () => {
    const calls = mountSidebar({ props: { onFork: (item) => calls.push(['fork', item.id]) } });
    act(() => workingThreadRow().querySelector('.thread-menu').click());
    act(() => buttonWithText(document.body.querySelector('.conversation-menu'), 'Copy thread ID').click());
    await flush();
    expect(clipboardWrites).toEqual(['working']);
    expect(root.querySelector('.sidebar-feedback.is-success').textContent).toContain('copied');

    clipboardShouldFail = true;
    act(() => workingThreadRow().querySelector('.thread-menu').click());
    act(() => buttonWithText(document.body.querySelector('.conversation-menu'), 'Copy thread ID').click());
    await flush();
    expect(root.querySelector('.sidebar-feedback.is-error').textContent).toContain('Clipboard write was blocked.');
  });

  test('bots without a conversation do not pretend to open one', () => {
    const calls = mountSidebar({
      bots: [
        { id: 'bot-1', name: 'Idle bot', enabled: true, scheduleState: 'active' },
        { id: 'bot-2', conversationId: 'thread-9', name: 'Linked bot', enabled: true, scheduleState: 'active' },
      ],
    });
    const buttons = [...root.querySelectorAll('.bot-open')];
    expect(buttons[0].disabled).toBeTrue();
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    expect(calls).toEqual([['select', 'thread-9']]);
  });

  test('new chat controls are disabled when the instance does not expose creation', () => {
    mountSidebar({ props: { onCreate: undefined } });
    const newChat = root.querySelector('[aria-label="New chat"]');
    expect(newChat.disabled).toBeTrue();
    expect(newChat.title).toContain('does not allow creating');
    act(() => newChat.click());
    expect(document.body.querySelector('.folder-picker')).toBeNull();
    const folderNewChat = root.querySelector('.folder-new-chat');
    expect(folderNewChat.disabled).toBeTrue();
    act(() => folderNewChat.click());
    expect(document.body.querySelector('.folder-picker')).toBeNull();
  });

  test('tag saving blocks duplicate submits, closes on success, and keeps errors local', async () => {
    let resolveSave;
    mountSidebar({ props: {
      tags: [{ id: 'urgent', name: 'Urgent', color: '#ee7d7d' }],
      onSaveTags: () => new Promise((resolve) => { resolveSave = resolve; }),
    } });
    act(() => root.querySelector('[aria-label="Filter conversations"]').click());
    act(() => buttonWithText(document.body.querySelector('[role="menu"][aria-label="Filter conversations"]'), 'Manage tags').click());
    const saveButton = buttonWithText(root.querySelector('.manage-dialog'), 'Save tags');
    act(() => saveButton.click());
    await flush();
    expect(saveButton.disabled).toBeTrue();
    act(() => saveButton.click());
    await act(async () => { resolveSave(); await flush(); });
    expect(root.querySelector('.manage-dialog')).toBeNull();
    expect(root.querySelector('.sidebar-feedback').textContent).toContain('Tags saved.');

    mountSidebar({ props: {
      tags: [{ id: 'urgent', name: 'Urgent', color: '#ee7d7d' }],
      onSaveTags: () => Promise.reject(new Error('Tags endpoint refused.')),
    } });
    act(() => root.querySelector('[aria-label="Filter conversations"]').click());
    act(() => buttonWithText(document.body.querySelector('[role="menu"][aria-label="Filter conversations"]'), 'Manage tags').click());
    act(() => buttonWithText(root.querySelector('.manage-dialog'), 'Save tags').click());
    await flush();
    expect(root.querySelector('.dialog-error').textContent).toContain('Tags endpoint refused.');
    expect(root.querySelector('.manage-dialog')).not.toBeNull();
    act(() => buttonWithText(root.querySelector('.manage-dialog'), 'Cancel').click());
    expect(root.querySelector('.manage-dialog')).toBeNull();
  });

  test('bot creation reports busy and keeps the dialog open on failure', async () => {
    let resolveCreate;
    let createCalls = 0;
    mountSidebar({ props: { onCreateBot: () => new Promise((resolve) => { createCalls += 1; resolveCreate = resolve; }) } });
    act(() => root.querySelector('[aria-label="New bot"]').click());
    const form = root.querySelector('.bot-form');
    const nameInput = form.querySelector('input[type="text"]');
    act(() => {
      nameInput.value = 'Deploy bot';
      nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    act(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(createCalls).toBe(1);
    expect(buttonWithText(form, 'Create bot').disabled).toBeTrue();
    act(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(createCalls).toBe(1);
    await act(async () => { resolveCreate(); await flush(); });
    expect(root.querySelector('.bot-form')).toBeNull();
    expect(root.querySelector('.sidebar-feedback').textContent).toContain('created');

    mountSidebar({ props: { onCreateBot: () => Promise.reject(new Error('Bot creation was refused.')) } });
    act(() => root.querySelector('[aria-label="New bot"]').click());
    const failingForm = root.querySelector('.bot-form');
    const failingName = failingForm.querySelector('input[type="text"]');
    act(() => {
      failingName.value = 'Deploy bot';
      failingName.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    act(() => failingForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(root.querySelector('.dialog-error').textContent).toContain('Bot creation was refused.');
    expect(root.querySelector('.bot-form')).not.toBeNull();
    act(() => buttonWithText(root.querySelector('.bot-form'), 'Cancel').click());
    expect(root.querySelector('.bot-form')).toBeNull();
  });

  test('conversation menus support arrow, home, and end keyboard navigation', async () => {
    mountSidebar({ props: {
      onRename: () => Promise.resolve(),
      onFork: () => Promise.resolve(),
      onArchive: () => Promise.resolve(),
      onDelete: () => Promise.resolve(),
    } });
    act(() => workingThreadRow().querySelector('.thread-menu').click());
    await flush();
    const menu = document.body.querySelector('.conversation-menu');
    const items = [...menu.querySelectorAll('[role^="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    const press = (key) => act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    press('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press('ArrowUp');
    expect(document.activeElement).toBe(items[0]);
    press('End');
    expect(document.activeElement).toBe(items.at(-1));
    press('Home');
    expect(document.activeElement).toBe(items[0]);
  });
});
