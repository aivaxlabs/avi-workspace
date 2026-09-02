import { describe, expect, test } from 'bun:test';
import {
  deriveBotStatus,
  deriveConversationStatus,
  deriveSidebarState,
  deriveTaskGroups,
  filterSidebarConversations,
  normalizeSearchResults,
  normalizeSidebarSnapshot,
} from '../src/lib/sidebar-state.js';

const conversations = [
  { id: 'old', title: 'Old', updatedAt: '2026-08-01T00:00:00Z' },
  { id: 'new', title: 'New', updatedAt: '2026-09-01T00:00:00Z' },
  { id: 'agent', title: 'Agent', createdBy: 'agent', tags: ['red'], updatedAt: '2026-09-02T00:00:00Z' },
  { id: 'tagged', title: 'Tagged', tags: ['blue'], updatedAt: '2026-08-15T00:00:00Z' },
];

describe('sidebar state projections', () => {
  test('normalizes absent and public RPC snapshots', () => {
    expect(normalizeSidebarSnapshot()).toEqual({
      running: [],
      approvalPending: [],
      inputPending: [],
      semaphoreWaiting: [],
      completedUnseen: [],
    });
    expect(normalizeSidebarSnapshot({
      runningConversationIds: ['running'],
      approvalPendingConversationIds: ['approval'],
      inputPendingConversationIds: ['input'],
      semaphoreWaitingConversationIds: ['semaphore'],
      completedUnseenConversationIds: ['review'],
    })).toEqual({
      running: ['running'],
      approvalPending: ['approval'],
      inputPending: ['input'],
      semaphoreWaiting: ['semaphore'],
      completedUnseen: ['review'],
    });
  });

  test('filters agent-created conversations and matches any active tag', () => {
    expect(filterSidebarConversations(conversations).map(({ id }) => id)).toEqual(['old', 'new', 'tagged']);
    expect(filterSidebarConversations(conversations, { activeTagIds: ['red', 'blue'] }).map(({ id }) => id)).toEqual(['tagged']);
    expect(filterSidebarConversations(conversations, { activeTagIds: ['red'], showAgentCreatedThreads: true }).map(({ id }) => id)).toEqual(['agent']);
  });

  test('derives conversation status with desktop precedence', () => {
    const snapshot = {
      running: { c: true },
      approvalPending: { c: true },
      inputPending: { c: true },
      semaphoreWaiting: { c: true },
      completedUnseen: { c: true },
    };
    expect(deriveConversationStatus({ id: 'c' }, snapshot)).toEqual({ state: 'approval', label: 'Awaiting approval' });
    expect(deriveConversationStatus({ id: 'c' }, { ...snapshot, approvalPending: {} })).toEqual({ state: 'input', label: 'Awaiting input' });
    expect(deriveConversationStatus({ id: 'c' }, { ...snapshot, approvalPending: {}, inputPending: {} })).toEqual({ state: 'semaphore', label: 'Waiting for semaphore' });
    expect(deriveConversationStatus({ id: 'c' }, { ...snapshot, approvalPending: {}, inputPending: {}, semaphoreWaiting: {} })).toEqual({ state: 'working', label: 'Working' });
    expect(deriveConversationStatus({ id: 'c', workStatus: 'blocked' }, {})).toEqual({ state: 'blocked', label: 'Blocked' });
  });

  test('separates sorted Working and Review groups and excludes Working from Review', () => {
    const items = [
      { id: 'review-old', title: 'Review old', updatedAt: '2026-08-01T00:00:00Z' },
      { id: 'working-new', title: 'Working new', updatedAt: '2026-09-01T00:00:00Z', needsAttention: true },
      { id: 'review-new', title: 'Review new', updatedAt: '2026-09-02T00:00:00Z' },
      { id: 'blocked', title: 'Blocked', updatedAt: '2026-08-20T00:00:00Z', workStatus: 'blocked' },
    ];
    const groups = deriveTaskGroups(items, {
      running: ['running'],
      approvalPending: ['approval'],
      inputPending: ['input'],
      semaphoreWaiting: ['semaphore'],
      completedUnseen: { 'review-old': true, 'working-new': true, 'review-new': true, blocked: true },
    });
    expect(groups.working.map(({ id }) => id)).toEqual(['working-new', 'blocked']);
    expect(groups.review.map(({ id }) => id)).toEqual(['review-new', 'review-old']);
  });

  test('derives bot status and public search result shape', () => {
    expect(deriveBotStatus({ running: true, enabled: false })).toEqual({ state: 'working', label: 'Working' });
    expect(deriveBotStatus({ enabled: false })).toEqual({ state: 'disabled', label: 'Disabled' });
    expect(deriveBotStatus({ scheduleState: 'sleep' })).toEqual({ state: 'sleep', label: 'Sleep' });
    expect(deriveBotStatus({})).toEqual({ state: 'active', label: 'Active' });
    expect(normalizeSearchResults([
      { conversationId: 'c1', title: 'Found', folderName: 'avi', content: 'Preview', extra: 'drop' },
      { conversationId: 'missing-title' },
      { title: 'missing-id' },
    ])).toEqual([{
      conversationId: 'c1',
      title: 'Found',
      folderName: 'avi',
      folderDisplayPath: 'avi',
      updatedAt: null,
      content: 'Preview',
    }]);
  });

  test('returns one normalized projection for all sidebar sources', () => {
    const state = deriveSidebarState({ conversations, tags: [{ id: 'blue', name: 'Blue' }], bots: [{ id: 'b1' }], activeTagIds: ['blue'] });
    expect(state.conversations.map(({ id }) => id)).toEqual(['tagged']);
    expect(state.tags).toEqual([{ id: 'blue', name: 'Blue', active: true }]);
    expect(state.bots[0].status).toEqual({ state: 'active', label: 'Active' });
  });
});
