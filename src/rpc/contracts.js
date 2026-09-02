export const RPC_PROTOCOL = 'avi-rpc-v1';
export const SUPPORTED_RPC_API_VERSIONS = Object.freeze([1]);
export const HISTORY_PAGE_SIZE = 40;

export const METHODS = Object.freeze({
  discover: 'rpc:discover',
  listConversations: 'conversations:list',
  searchConversations: 'conversations:search',
  createConversation: 'conversations:create',
  updateConversation: 'conversations:update',
  archiveConversation: 'conversations:archive',
  deleteConversation: 'conversations:delete',
  forkConversation: 'conversations:fork',
  setConversationTags: 'conversations:set-tags',
  listFolders: 'folders:list',
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
  models: 'models:list',
  conversationContext: 'conversations:context',
  conversationMessages: 'conversations:messages',
  toolCallDetails: 'conversations:tool-call-details',
  composerGet: 'composer-state:get',
  composerSave: 'composer-state:save',
  send: 'chat:send',
  stop: 'chat:stop',
  cancelQueued: 'chat:cancel-queued',
  reorderQueued: 'chat:reorder-queued',
  runSemaphoreNow: 'chat:run-semaphore-now',
  cancelSemaphore: 'chat:cancel-semaphore',
  resolveApproval: 'chat:resolve-approval',
  answerQuestion: 'chat:answer-question',
  createSideChat: 'side-chats:create',
  startGoal: 'goals:start',
  mentions: 'mentions:list',
  commands: 'context:commands',
  filesDiff: 'files:diff',
  readAttachment: 'attachments:read',
});

export const ATTACHMENT_CHUNK_SIZE = 256 * 1024;

export function messagePageParams({ cursor = null, limit = HISTORY_PAGE_SIZE } = {}) {
  return { limit, ...(cursor ? { cursor } : {}) };
}

export function attachmentReadParams(input, offset, limit = ATTACHMENT_CHUNK_SIZE) {
  if (Object.hasOwn(input ?? {}, 'path') || Object.hasOwn(input ?? {}, 'filePath')) {
    throw new Error('Remote attachment reads do not accept caller-supplied paths.');
  }
  const { messageId, attachmentId } = input ?? {};
  if (!messageId || !attachmentId) throw new Error('Remote attachment reads require messageId and attachmentId.');
  return { messageId, attachmentId, offset, limit };
}

export function normalizeAttachmentChunk(result) {
  if (typeof result?.data !== 'string' || typeof result?.mime !== 'string' || typeof result?.hasMore !== 'boolean') {
    throw new Error('Avi returned an invalid attachment chunk.');
  }
  return {
    data: result.data,
    mime: result.mime,
    name: result.name ?? 'attachment',
    cursor: result.cursor ?? null,
    hasMore: result.hasMore,
  };
}

export function readApiVersion(discovery) {
  return Number.isInteger(discovery?.versions?.rpc) ? discovery.versions.rpc : null;
}

export function normalizeModelsResult(result) {
  if (
    !Array.isArray(result?.models)
    || !result.models.every((model) => (
      typeof model?.id === 'string'
      && model.id.length > 0
      && Array.isArray(model.reasoning)
      && model.reasoning.every((effort) => typeof effort === 'string')
    ))
    || !['queue', 'steer'].includes(result?.messageDeliveryMode)
  ) {
    throw new Error('Avi returned an invalid model catalog.');
  }
  return result;
}

export function validateDiscovery(discovery) {
  const apiVersion = readApiVersion(discovery);
  if (!SUPPORTED_RPC_API_VERSIONS.includes(apiVersion)) {
    throw new Error(`Unsupported RPC API version ${apiVersion ?? 'unknown'}. This client requires v${SUPPORTED_RPC_API_VERSIONS.join(' or v')}.`);
  }
  if (!Array.isArray(discovery?.methods) || !discovery.methods.every((method) => typeof method === 'string')) {
    throw new Error('Avi returned an invalid RPC method discovery list.');
  }
  return { ...discovery, apiVersion };
}

export function supportsMethod(discovery, method) {
  return Array.isArray(discovery?.methods) && discovery.methods.includes(method);
}
