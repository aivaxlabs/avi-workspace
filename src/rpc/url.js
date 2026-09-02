import { RPC_PROTOCOL } from './contracts.js';

export function normalizeServerUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Server URL is required.');
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS server URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Credentials must not be embedded in the server URL.');
  if (url.search || url.hash) throw new Error('Server URL cannot include a query or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function toWebSocketUrl(serverUrl, path = '/rpc') {
  const url = new URL(normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function encodeApiKeyProtocol(apiKey) {
  const key = String(apiKey ?? '');
  if (!key.trim()) throw new Error('API key is required.');
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `avi-api-key.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

export function createAuthProtocols(apiKey) {
  return [RPC_PROTOCOL, encodeApiKeyProtocol(apiKey)];
}

export function conversationSocketPath(conversationId) {
  if (!conversationId) throw new Error('Conversation ID is required.');
  return `/rpc/conversations/streams/${encodeURIComponent(conversationId)}`;
}
