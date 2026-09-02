const STATUS_LABELS = Object.freeze({
  approval: 'Awaiting approval',
  input: 'Awaiting input',
  semaphore: 'Waiting for semaphore',
  working: 'Working',
  blocked: 'Blocked',
  attention: 'Needs attention',
  completed: 'Completed',
  idle: 'Idle',
});

function selectedTagIds(activeTagIds) {
  return new Set(activeTagIds instanceof Set ? activeTagIds : activeTagIds ?? []);
}

export function normalizeSidebarSnapshot(snapshot = {}) {
  return {
    running: snapshot?.runningConversationIds ?? snapshot?.running ?? [],
    approvalPending: snapshot?.approvalPendingConversationIds ?? snapshot?.approvalPending ?? [],
    inputPending: snapshot?.inputPendingConversationIds ?? snapshot?.inputPending ?? [],
    semaphoreWaiting: snapshot?.semaphoreWaitingConversationIds ?? snapshot?.semaphoreWaiting ?? [],
    completedUnseen: snapshot?.completedUnseenConversationIds ?? snapshot?.completedUnseen ?? [],
  };
}

function hasConversationEntry(source, conversationId) {
  if (!source) return false;
  if (source instanceof Map) {
    const value = source.get(conversationId);
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  }
  if (source instanceof Set) return source.has(conversationId);
  if (Array.isArray(source)) {
    return source.some((item) => item === conversationId || item?.conversationId === conversationId || item?.id === conversationId);
  }
  if (!Object.hasOwn(source, conversationId)) return false;
  const value = source[conversationId];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function updatedTime(conversation) {
  const time = Date.parse(conversation?.updatedAt ?? '');
  return Number.isFinite(time) ? time : 0;
}

function sortByUpdatedAt(conversations) {
  return [...conversations].sort((left, right) => updatedTime(right) - updatedTime(left));
}

export function filterSidebarConversations(conversations, { activeTagIds = [], showAgentCreatedThreads = false } = {}) {
  const selected = selectedTagIds(activeTagIds);
  return (Array.isArray(conversations) ? conversations : []).filter((conversation) => (
    (showAgentCreatedThreads || conversation?.createdBy !== 'agent')
    && (!selected.size || (conversation?.tags ?? []).some((tagId) => selected.has(tagId)))
  ));
}

export function deriveConversationStatus(conversation, snapshot = {}) {
  const id = conversation?.id;
  const normalizedSnapshot = normalizeSidebarSnapshot(snapshot);
  const status = hasConversationEntry(normalizedSnapshot.approvalPending, id)
    ? 'approval'
    : hasConversationEntry(normalizedSnapshot.inputPending, id)
      ? 'input'
      : hasConversationEntry(normalizedSnapshot.semaphoreWaiting, id)
        ? 'semaphore'
        : hasConversationEntry(normalizedSnapshot.running, id) || conversation?.workStatus === 'running'
          ? 'working'
          : conversation?.workStatus === 'blocked'
            ? 'blocked'
            : conversation?.needsAttention
              ? 'attention'
              : hasConversationEntry(normalizedSnapshot.completedUnseen, id)
                ? 'completed'
                : 'idle';
  return { state: status, label: STATUS_LABELS[status] };
}

export function deriveTaskGroups(conversations, snapshot = {}, filters = {}) {
  const normalizedSnapshot = normalizeSidebarSnapshot(snapshot);
  const sorted = sortByUpdatedAt(filterSidebarConversations(conversations, filters));
  const working = sorted.filter((conversation) => ['approval', 'input', 'semaphore', 'working', 'blocked', 'attention'].includes(
    deriveConversationStatus(conversation, normalizedSnapshot).state,
  ));
  const workingIds = new Set(working.map((conversation) => conversation.id));
  const review = sorted.filter((conversation) => (
    hasConversationEntry(normalizedSnapshot.completedUnseen, conversation.id) && !workingIds.has(conversation.id)
  ));
  return { working, review };
}

export function deriveTagFilters(tags, activeTagIds = []) {
  const selected = selectedTagIds(activeTagIds);
  return (Array.isArray(tags) ? tags : []).map((tag) => ({
    ...tag,
    active: selected.has(tag?.id),
  }));
}

export function deriveBotStatus(bot) {
  const state = bot?.running || bot?.scheduleState === 'working'
    ? 'working'
    : bot?.enabled === false || bot?.scheduleState === 'disabled'
      ? 'disabled'
      : bot?.scheduleState === 'sleep'
        ? 'sleep'
        : 'active';
  return { state, label: state[0].toUpperCase() + state.slice(1) };
}

export function normalizeSearchResults(results) {
  const items = Array.isArray(results) ? results : results?.results ?? results?.matches ?? [];
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const result = item?.conversation ?? item;
    const conversationId = result?.conversationId ?? result?.id;
    const title = result?.title ?? result?.firstPrompt;
    if (conversationId == null || title == null || !String(conversationId).trim() || !String(title).trim()) return [];
    const folderName = result.folderName ?? result.projectName ?? '~/';
    return [{
      conversationId,
      title,
      folderName,
      folderDisplayPath: result.folderDisplayPath ?? result.projectDisplayPath ?? result.projectPath ?? folderName,
      updatedAt: result.updatedAt ?? result.createdAt ?? null,
      content: result.content ?? result.preview ?? result.snippet ?? '',
    }];
  });
}

export function deriveSidebarState({ conversations = [], bots = [], tags = [], snapshot = {}, activeTagIds = [], showAgentCreatedThreads = false, searchResults = [] } = {}) {
  const filters = { activeTagIds, showAgentCreatedThreads };
  const visibleConversations = sortByUpdatedAt(filterSidebarConversations(conversations, filters));
  const taskGroups = deriveTaskGroups(conversations, snapshot, filters);
  return {
    conversations: visibleConversations,
    working: taskGroups.working,
    review: taskGroups.review,
    bots: (Array.isArray(bots) ? bots : []).map((bot) => ({ ...bot, status: deriveBotStatus(bot) })),
    tags: deriveTagFilters(tags, activeTagIds),
    searchResults: normalizeSearchResults(searchResults),
  };
}
