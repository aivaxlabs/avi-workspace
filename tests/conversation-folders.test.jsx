import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';
import { buildFolderNavigation, conversationCreateParams, FOLDER_GROUP_LIMIT, folderDisplayName } from '../src/lib/conversation-folders.js';

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

let ConversationSidebar;

beforeAll(async () => {
  ({ ConversationSidebar } = await import('../src/components/ConversationSidebar.jsx'));
});

afterEach(() => {
  document.body.replaceChildren();
});

const folders = [
  { path: 'C:\\Users\\test', name: '~/', displayPath: '~/', gitBranch: null, color: null },
  { path: 'C:\\Code\\core', name: 'core', displayPath: 'C:\\Code\\core', gitBranch: 'main', color: null },
  { path: 'C:\\Code\\avi', name: 'avi', displayPath: 'C:\\Code\\avi', gitBranch: 'canary', color: null },
];
const conversations = [
  ...Array.from({ length: 7 }, (_, index) => ({ id: `core-${index}`, title: `Core ${index}`, projectPath: 'C:\\Code\\core', projectName: 'core', projectDisplayPath: 'C:\\Code\\core', updatedAt: `2026-09-01T10:0${index}:00.000Z` })),
  { id: 'avi-1', title: 'Avi thread', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi', updatedAt: '2026-09-01T11:00:00.000Z' },
  { id: 'home-1', title: 'Home thread', projectPath: 'C:\\Users\\test', projectName: '~/', projectDisplayPath: '~/', updatedAt: '2026-09-01T12:00:00.000Z' },
  { id: 'child-1', title: 'Child', projectPath: 'C:\\Code\\core', parentConversationId: 'core-1', updatedAt: '2026-09-01T12:30:00.000Z' },
];

describe('conversation folders', () => {
  test('shows only the final path segment while preserving canonical paths', () => {
    expect(folderDisplayName('C:\\Code\\repos\\chat-app-electron')).toBe('chat-app-electron');
    expect(folderDisplayName('/srv/repos/avi-workspace/')).toBe('avi-workspace');
    expect(buildFolderNavigation(
      [{ path: 'C:\\Code\\repos\\chat-app-electron', name: 'C:\\Code\\repos\\chat-app-electron', displayPath: 'C:\\Code\\repos\\chat-app-electron' }],
      [{ id: 'nested', projectPath: 'C:\\Code\\repos\\chat-app-electron', updatedAt: '2026-09-01T12:00:00.000Z' }],
    ).groups[0]).toMatchObject({ label: 'chat-app-electron', displayPath: 'C:\\Code\\repos\\chat-app-electron' });
  });

  test('groups top-level conversations by canonical projectPath with home last', () => {
    const navigation = buildFolderNavigation(folders, [
      ...conversations,
      { id: 'unassigned-1', title: 'Unassigned', projectPath: null, updatedAt: '2026-09-01T12:15:00.000Z' },
    ]);
    expect(navigation.groups.map((group) => group.label)).toEqual(['avi', 'core', 'Chats']);
    expect(navigation.groups.find((group) => group.label === 'core').items).toHaveLength(7);
    expect(navigation.groups.find((group) => group.label === 'Chats').items.map((item) => item.id)).toEqual(['home-1', 'unassigned-1']);
    expect(navigation.groups.flatMap((group) => group.items).some((item) => item.id === 'child-1')).toBeFalse();
  });

  test('creates conversations with the selected folder and omits the home path', () => {
    expect(conversationCreateParams({ path: 'C:\\Code\\core', isHome: false }, 'model:one')).toEqual({ model: 'model:one', projectPath: 'C:\\Code\\core' });
    expect(conversationCreateParams({ path: 'C:\\Users\\test', isHome: true }, 'model:one')).toEqual({ model: 'model:one' });
    expect(conversationCreateParams({ path: null, isHome: true }, 'model:one')).toEqual({ model: 'model:one' });
  });

  test('keeps a synthetic home choice when only unassigned conversations identify it', () => {
    const navigation = buildFolderNavigation(
      [{ path: 'C:\\Code\\core', name: 'core', displayPath: 'C:\\Code\\core' }],
      [{ id: 'home-only', title: 'Home', projectPath: null, updatedAt: '2026-09-01T12:00:00.000Z' }],
    );
    expect(navigation.choices.map((choice) => choice.label)).toEqual(['core', 'Chats']);
    expect(navigation.choices.at(-1)).toMatchObject({ path: null, isHome: true });
  });

  test('mounts folder groups, picker, bounded rows, and folder actions', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const created = [];
    act(() => render(h(ConversationSidebar, {
      collapsed: false,
      connection: { label: 'Test Avi' },
      conversations,
      folders,
      selectedId: 'core-0',
      onCollapse() {},
      onCreate(folder) { created.push(folder.path); },
      onExit() {},
      onRename() {},
      onSelect() {},
    }), root));

    const coreFolder = [...root.querySelectorAll('.conversation-folder')].find((section) => section.textContent.includes('Core 0'));
    expect(coreFolder.querySelectorAll('.thread-list > li')).toHaveLength(FOLDER_GROUP_LIMIT);
    const showMore = coreFolder.querySelector('.show-more');
    expect(showMore.textContent).toContain('Show 2 more');
    expect(showMore.getAttribute('aria-expanded')).toBe('false');
    expect(showMore.querySelector('.ri-arrow-down-s-line')).toBeTruthy();
    act(() => showMore.click());
    expect(showMore.getAttribute('aria-expanded')).toBe('true');
    expect(showMore.textContent).toContain('Show less');
    expect(coreFolder.querySelectorAll('.thread-list > li')).toHaveLength(7);

    act(() => root.querySelector('.nav-action').click());
    expect(document.querySelector('.folder-picker').getAttribute('role')).toBe('menu');
    const coreChoice = [...document.querySelectorAll('.folder-picker [role="menuitem"]')].find((button) => button.textContent.includes('C:\\Code\\core'));
    act(() => coreChoice.click());
    expect(created).toEqual(['C:\\Code\\core']);

    const toggle = coreFolder.querySelector('.folder-toggle');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(coreFolder.querySelector('.thread-list')).toBeNull();
  });
});
