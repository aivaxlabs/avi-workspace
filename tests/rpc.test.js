import { describe, expect, test } from 'bun:test';
import { createAuthProtocols, normalizeServerUrl, toWebSocketUrl } from '../src/rpc/url.js';
import { applyConversationEvent, prependOlderMessages, recoverConversationState } from '../src/state/conversation.js';
import { normalizeMessagePage } from '../src/rpc/pagination.js';
import { attachmentReadParams, normalizeAttachmentChunk, normalizeModelsResult, validateDiscovery } from '../src/rpc/contracts.js';

describe('RPC contracts', () => {
  test('normalizes server and WebSocket URLs without embedding credentials', () => {
    expect(normalizeServerUrl('127.0.0.1:18992/')).toBe('http://127.0.0.1:18992');
    expect(toWebSocketUrl('https://avi.example/base', '/rpc')).toBe('wss://avi.example/base/rpc');
    expect(createAuthProtocols('secret key')[0]).toBe('avi-orpc-draft1');
    expect(createAuthProtocols('secret key')[1]).toStartWith('avi-api-key.');
    expect(toWebSocketUrl('http://localhost:18992')).not.toContain('secret');
  });

  test('rejects unsupported RPC versions without fallback', () => {
    expect(validateDiscovery({ versions: { rpc: 1, core: 2, mcp: { latest: '2025-11-25' } }, methods: [] }).apiVersion).toBe(1);
    expect(() => validateDiscovery({ apiVersion: 1, methods: [] })).toThrow('Unsupported RPC API version');
    expect(() => validateDiscovery({ versions: { rpc: '1' }, methods: [] })).toThrow('Unsupported RPC API version');
    expect(() => validateDiscovery({ versions: { rpc: 2 }, methods: [] })).toThrow('Unsupported RPC API version');
    expect(() => validateDiscovery({ versions: { rpc: 1 }, methods: {} })).toThrow('invalid RPC method discovery list');
  });

  test('requires the canonical model catalog envelope', () => {
    expect(normalizeModelsResult({ models: [{ id: 'test:model', reasoning: ['low', 'high'] }], lastModel: 'test:model', defaultModels: null, messageDeliveryMode: 'steer' })).toMatchObject({ messageDeliveryMode: 'steer' });
    expect(() => normalizeModelsResult([{ id: 'test:model', reasoning: [] }])).toThrow('invalid model catalog');
    expect(() => normalizeModelsResult({ models: [{ id: 'test:model', reasoning: [] }] })).toThrow('invalid model catalog');
    expect(() => normalizeModelsResult({ models: [{ id: 'test:model', reasoning: [] }], messageDeliveryMode: 'invalid' })).toThrow('invalid model catalog');
  });

  test('requires owned attachment identifiers and canonical chunk fields', () => {
    expect(attachmentReadParams({ messageId: 'm1', attachmentId: 'a1' }, 0)).toEqual({ messageId: 'm1', attachmentId: 'a1', offset: 0, limit: 262144 });
    expect(() => attachmentReadParams({ attachmentId: 'a1', path: 'C:/secret' }, 0)).toThrow();
    expect(normalizeAttachmentChunk({ data: 'YQ==', mime: 'text/plain', name: 'a.txt', cursor: null, hasMore: false })).toEqual({ data: 'YQ==', mime: 'text/plain', name: 'a.txt', cursor: null, hasMore: false });
    expect(() => normalizeAttachmentChunk({ base64: 'YQ==', mimeType: 'text/plain', done: true })).toThrow('invalid attachment chunk');
  });

  test('normalizes bounded pages and rejects old unbounded results', () => {
    expect(normalizeMessagePage({ messages: [{ id: '2' }], cursor: 'c1', hasMore: true })).toEqual({ messages: [{ id: '2' }], nextCursor: 'c1', hasMore: true });
    expect(() => normalizeMessagePage([])).toThrow('removed unbounded message format');
  });
});

describe('authoritative conversation reducer', () => {
  test('applies ordered events and requests recovery on a gap', () => {
    const initial = recoverConversationState({ messages: [{ id: '1', content: 'old' }] });
    const next = applyConversationEvent(initial, { sequence: 1, event: { type: 'message', message: { id: '1', content: 'new' } } });
    expect(next.messages[0].content).toBe('new');
    expect(applyConversationEvent(next, { sequence: 3, event: { type: 'run-state', running: true } }).recoveryRequired).toBe(true);
  });

  test('prepends older messages without duplicates', () => {
    expect(prependOlderMessages([{ id: '2' }], [{ id: '1' }, { id: '2' }]).map((item) => item.id)).toEqual(['1', '2']);
  });
});
