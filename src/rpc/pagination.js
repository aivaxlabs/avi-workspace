import { HISTORY_PAGE_SIZE, METHODS } from './contracts.js';

export function createInitialHistoryRequest(limit = HISTORY_PAGE_SIZE) {
  return { limit };
}

export function createOlderHistoryRequest(page, limit = HISTORY_PAGE_SIZE) {
  if (!page?.hasMore || !page?.nextCursor) return null;
  return { limit, cursor: page.nextCursor };
}

export function normalizeMessagePage(result) {
  if (Array.isArray(result)) {
    throw new Error('The server returned the removed unbounded message format. A paginated RPC API is required.');
  }
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  return {
    messages,
    nextCursor: result?.nextCursor ?? result?.cursor ?? null,
    hasMore: Boolean(result?.hasMore ?? result?.nextCursor ?? result?.cursor),
  };
}

export async function loadRecentMessages(client, limit = HISTORY_PAGE_SIZE) {
  return normalizeMessagePage(await client.request(METHODS.conversationMessages, createInitialHistoryRequest(limit)));
}

export async function loadOlderMessages(client, page, limit = HISTORY_PAGE_SIZE) {
  const request = createOlderHistoryRequest(page, limit);
  return request ? normalizeMessagePage(await client.request(METHODS.conversationMessages, request)) : page;
}
