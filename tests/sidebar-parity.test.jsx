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
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  confirm: () => true,
  prompt: () => 'Renamed thread',
});

let ConversationSidebar;
let root;

beforeAll(async () => {
  ({ ConversationSidebar } = await import('../src/components/ConversationSidebar.jsx'));
});

afterEach(() => {
  if (root) act(() => render(null, root));
  document.body.replaceChildren();
  root = null;
});

const conversations = [
  { id: 'working', title: 'Working thread', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi', updatedAt: '2026-09-01T12:00:00Z', tags: ['urgent'] },
  { id: 'review', title: 'Review thread', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi', updatedAt: '2026-09-01T11:00:00Z' },
  { id: 'agent', title: 'Agent thread', createdBy: 'agent', projectPath: 'C:\\Code\\avi', projectName: 'avi', projectDisplayPath: 'C:\\Code\\avi', updatedAt: '2026-09-01T10:00:00Z' },
];

function buttonWithText(container, text) {
  return [...container.querySelectorAll('button')].find((button) => button.textContent.includes(text));
}

describe('sidebar Desktop parity', () => {
  test('renders Bots, Working/Review, search, tags, filters, and conversation actions', async () => {
    const calls = [];
    root = document.createElement('div');
    document.body.append(root);
    act(() => render(h(ConversationSidebar, {
      capabilities: { bots: true, folderColor: true, search: true, status: true, tags: true },
      collapsed: false,
      connection: { label: 'Test Avi' },
      conversations,
      folders: [{ path: 'C:\\Code\\avi', name: 'avi', displayPath: 'C:\\Code\\avi', color: '#8aa7ff' }],
      models: [{ id: 'model:one', name: 'Model One' }],
      bots: [{ id: 'bot-1', conversationId: 'bot-thread', name: 'Release bot', model: 'model:one', enabled: true, scheduleState: 'active', attentionCount: 2 }],
      tags: [{ id: 'urgent', name: 'Urgent', color: '#ee7d7d' }],
      sidebarStatus: { runningConversationIds: ['working'], completedUnseenConversationIds: ['review'] },
      schedulerSnooze: { active: false, mode: null, until: null },
      selectedId: 'working',
      onActivateBot: (bot) => calls.push(['activate', bot.id]),
      onArchive: (item) => calls.push(['archive', item.id]),
      onCreate() {},
      onCreateBot: (input) => calls.push(['create-bot', input]),
      onDelete: (item) => calls.push(['delete', item.id]),
      onDeleteBot: (bot) => calls.push(['delete-bot', bot.id]),
      onExit() {},
      onFork: (item) => calls.push(['fork', item.id]),
      onRename: (item, title) => calls.push(['rename', item.id, title]),
      onSaveFolderColor: (folder, color) => calls.push(['folder-color', folder.path, color]),
      onSaveTags: (items) => calls.push(['save-tags', items]),
      onSearch: () => Promise.resolve([{ conversationId: 'review', title: 'Review thread', folderName: 'avi', content: 'Matched content' }]),
      onSelect: (id) => calls.push(['select', id]),
      onSetConversationTags: (item, items) => calls.push(['thread-tags', item.id, items]),
      onSnoozeBot: (bot) => calls.push(['snooze-bot', bot.id]),
      onSnoozeBots: () => calls.push(['snooze-bots']),
      onUpdateBot: (bot, changes) => calls.push(['update-bot', bot.id, changes]),
    }), root));

    expect(root.textContent).toContain('Bots');
    expect(root.textContent).toContain('Release bot');
    expect(root.textContent).toContain('Working');
    expect(root.textContent).toContain('Review');
    expect(root.querySelector('.working-group .thread-open small').textContent).toBe('avi');
    expect(root.querySelector('.working-group .thread-open small').title).toBe('C:\\Code\\avi');
    expect(root.querySelector('.working-group .task-group-label b').textContent).toBe('1');
    expect(root.querySelector('.review-group .task-group-label .ri-check-double-line')).toBeTruthy();
    expect(root.textContent).not.toContain('Agent thread');

    const filterTrigger = root.querySelector('[aria-label="Filter conversations"]');
    act(() => filterTrigger.click());
    act(() => buttonWithText(document.body.querySelector('[role="menu"][aria-label="Filter conversations"]'), 'Urgent').click());
    expect(root.textContent).toContain('Working thread');
    expect(root.textContent).not.toContain('Review thread');

    act(() => root.querySelector('[aria-label="Search chats"]').click());
    const input = root.querySelector('.search-dialog input');
    act(() => { input.value = 'review'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(root.querySelector('.search-results').textContent).toContain('Matched content');
    act(() => root.querySelector('.search-results button').click());
    expect(calls).toContainEqual(['select', 'review']);

    const workingRows = [...root.querySelectorAll('.thread-list > li')].filter((item) => item.textContent.includes('Working thread'));
    const threadTrigger = workingRows[0].querySelector('.thread-menu');
    act(() => threadTrigger.click());
    const conversationMenu = document.body.querySelector('.conversation-menu');
    expect(conversationMenu.parentElement).toBe(document.body);
    expect(workingRows.filter((row) => row.querySelector('.thread-menu').getAttribute('aria-expanded') === 'true')).toHaveLength(1);
    act(() => buttonWithText(conversationMenu, 'Fork').click());
    expect(calls).toContainEqual(['fork', 'working']);

    const botTrigger = root.querySelector('[aria-label="Actions for Release bot"]');
    act(() => botTrigger.click());
    act(() => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    expect(document.body.querySelector('[role="menu"][aria-label="Actions for Release bot"]')).toBeNull();
    expect(botTrigger.getAttribute('aria-expanded')).toBe('false');

    act(() => botTrigger.click());
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.body.querySelector('[role="menu"][aria-label="Actions for Release bot"]')).toBeNull();
    expect(botTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(botTrigger);

    act(() => botTrigger.click());
    act(() => buttonWithText(document.body.querySelector('[role="menu"][aria-label="Actions for Release bot"]'), 'Activate now').click());
    expect(calls).toContainEqual(['activate', 'bot-1']);
  });
});
