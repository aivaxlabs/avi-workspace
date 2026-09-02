import { describe, expect, test } from 'bun:test';
import { METHODS } from '../src/rpc/contracts.js';

const fallbackStatus = {
  runningConversationIds: [],
  approvalPendingConversationIds: [],
  inputPendingConversationIds: [],
  semaphoreWaitingConversationIds: [],
  completedUnseenConversationIds: [],
};

function normalizeSidebarResults({ botsResult, tagsResult, sidebarStatus }) {
  return {
    bots: botsResult?.bots ?? [],
    botWorkState: botsResult?.workStateByBot ?? {},
    schedulerSnooze: botsResult?.schedulerSnooze ?? { active: false, mode: null, until: null },
    tags: tagsResult?.tags ?? [],
    sidebarStatus: sidebarStatus ?? fallbackStatus,
  };
}

describe('sidebar RPC state', () => {
  test('declares every method used by the parity sidebar', () => {
    expect(METHODS).toMatchObject({
      searchConversations: 'conversations:search',
      archiveConversation: 'conversations:archive',
      deleteConversation: 'conversations:delete',
      forkConversation: 'conversations:fork',
      setConversationTags: 'conversations:set-tags',
      saveFolderColor: 'folders:save-color',
      listTags: 'tags:list',
      saveTags: 'tags:save',
      sidebarStatus: 'sidebar:status',
      markSidebarSeen: 'sidebar:mark-seen',
      listBots: 'bots:list',
      createBot: 'bots:create',
      updateBot: 'bots:update',
      deleteBot: 'bots:delete',
      activateBot: 'bots:activate',
      snoozeBot: 'bots:snooze-one',
      snoozeBots: 'bots:snooze',
    });
  });

  test('normalizes optional sidebar envelopes without inventing remote state', () => {
    expect(normalizeSidebarResults({})).toEqual({
      bots: [],
      botWorkState: {},
      schedulerSnooze: { active: false, mode: null, until: null },
      tags: [],
      sidebarStatus: fallbackStatus,
    });
    expect(normalizeSidebarResults({
      botsResult: { bots: [{ id: 'bot-1' }], workStateByBot: { 'bot-1': { items: [] } }, schedulerSnooze: { active: true, mode: 'until-restart', until: null } },
      tagsResult: { tags: [{ id: 'tag-1', name: 'Review', color: '#ffaa00' }] },
      sidebarStatus: { ...fallbackStatus, runningConversationIds: ['thread-1'] },
    })).toMatchObject({
      bots: [{ id: 'bot-1' }],
      tags: [{ id: 'tag-1', name: 'Review', color: '#ffaa00' }],
      sidebarStatus: { runningConversationIds: ['thread-1'] },
    });
  });
});
