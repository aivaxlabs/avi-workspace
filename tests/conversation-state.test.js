import { describe, expect, test } from 'bun:test';
import { createInitialHistoryRequest, createOlderHistoryRequest, normalizeMessagePage } from '../src/rpc/pagination.js';
import { applyConversationEvent, prependOlderMessages, recoverConversationState, refreshConversationProjection } from '../src/state/conversation.js';
import { initialUiState, uiReducer } from '../src/state/ui.js';

describe('bounded history pagination', () => {
  test('creates bounded recent and older requests', () => {
    expect(createInitialHistoryRequest(25)).toEqual({ limit: 25 });
    expect(createOlderHistoryRequest({ hasMore: true, nextCursor: 'before-1' }, 25)).toEqual({ limit: 25, cursor: 'before-1' });
    expect(createOlderHistoryRequest({ hasMore: false }, 25)).toBeNull();
  });

  test('requires paginated responses and normalizes cursors', () => {
    expect(normalizeMessagePage({ messages: [{ id: 'm1' }], nextCursor: 'c1', hasMore: true })).toEqual({ messages: [{ id: 'm1' }], nextCursor: 'c1', hasMore: true });
    expect(() => normalizeMessagePage([])).toThrow('removed unbounded message format');
  });
});

describe('conversation reducers', () => {
  test('authoritatively replaces recovery state', () => {
    const state = recoverConversationState({ conversation: { id: 'c1' }, messages: [{ id: 'm1' }], run: { active: true }, approvals: [{ approvalId: 'a1' }] });
    expect(state.conversation.id).toBe('c1');
    expect(state.run.active).toBeTrue();
    expect(state.approvals).toHaveLength(1);
  });

  test('applies ordered events and requests recovery on a sequence gap', () => {
    const initial = recoverConversationState({ messages: [{ id: 'm1', content: 'old' }] });
    const updated = applyConversationEvent(initial, { sequence: 1, event: { type: 'message', message: { id: 'm1', content: 'new' } } });
    expect(updated.messages[0].content).toBe('new');
    const gap = applyConversationEvent(updated, { sequence: 3, event: { type: 'run-state', running: true } });
    expect(gap.recoveryRequired).toBeTrue();
    expect(gap.run.active).toBeFalse();
  });

  test('prepends older messages without duplicate IDs', () => {
    expect(prependOlderMessages([{ id: 'm2' }], [{ id: 'm1' }, { id: 'm2' }])).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  test('keeps shell state memory-only through a pure reducer', () => {
    expect(uiReducer(initialUiState, { type: 'auxiliary:resize', width: 240 }).auxiliaryWidth).toBe(280);
    expect(uiReducer(initialUiState, { type: 'conversation:select', id: 'c1' }).activeConversationId).toBe('c1');
  });

  test('recovers the composer snapshot and context usage from conversations:context', () => {
    const state = recoverConversationState({
      composer: { permissionMode: 'full_access', model: 'm1', reasoningEffort: 'high', workMode: 'plan', ultraMode: true, draftText: 'draft', attachments: [{ id: 'a1', kind: 'context_marker' }] },
      contextUsage: { tokens: 900, limit: 1000 },
    });
    expect(state.composer).toEqual({ permissionMode: 'full_access', model: 'm1', reasoningEffort: 'high', workMode: 'plan', ultraMode: true, draftText: 'draft', attachments: [{ id: 'a1', kind: 'context_marker' }] });
    expect(state.contextUsage).toEqual({ tokens: 900, limit: 1000 });
    expect(recoverConversationState({}).composer).toBeNull();
    expect(recoverConversationState({}).contextUsage).toEqual({ tokens: 0, limit: null });
  });

  test('periodic projection refresh updates recent messages while preserving older history, composer, and sequence', () => {
    const base = recoverConversationState({
      conversation: { id: 'c1', title: 'Old' },
      composer: { draftText: 'local draft', model: 'm1' },
      messages: [
        { id: 'older', content: 'Loaded earlier' },
        { id: 'tool-message', segments: [{ id: 'tool-1', type: 'tool-call', hasResult: false }] },
      ],
    });
    base.lastSequence = 7;
    const refreshed = refreshConversationProjection(base, {
      conversation: { id: 'c1', title: 'New', gitBranch: 'main' },
      messages: [
        { id: 'tool-message', segments: [{ id: 'tool-1', type: 'tool-call', hasResult: true }] },
        { id: 'missed-message', content: 'Missed stream event' },
      ],
      queue: { steer: [], queued: [{ id: 'q1' }] },
      tasks: [{ title: 't1', done: false, status: 'pending', result: null }],
      subagents: [{ id: 's1', workStatus: 'working' }],
      rubberDucks: [],
      run: { active: true, startedAt: 1 },
      contextUsage: { tokens: 50, limit: 100 },
    });
    expect(refreshed.messages).toEqual([
      { id: 'older', content: 'Loaded earlier' },
      { id: 'tool-message', segments: [{ id: 'tool-1', type: 'tool-call', hasResult: true }] },
      { id: 'missed-message', content: 'Missed stream event' },
    ]);
    expect(refreshed.composer).toEqual({ draftText: 'local draft', model: 'm1' });
    expect(refreshed.lastSequence).toBe(7);
    expect(refreshed.conversation.title).toBe('New');
    expect(refreshed.queue.queued).toEqual([{ id: 'q1' }]);
    expect(refreshed.tasks).toHaveLength(1);
    expect(refreshed.subagents).toEqual([{ id: 's1', workStatus: 'working' }]);
    expect(refreshed.run).toEqual({ active: true, startedAt: 1 });
    expect(refreshed.contextUsage).toEqual({ tokens: 50, limit: 100 });
  });
});
