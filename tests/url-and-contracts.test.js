import { describe, expect, test } from 'bun:test';
import { attachmentReadParams, readApiVersion, validateDiscovery } from '../src/rpc/contracts.js';
import { conversationSocketPath, createAuthProtocols, encodeApiKeyProtocol, normalizeServerUrl, toWebSocketUrl } from '../src/rpc/url.js';

describe('RPC URL and browser authentication', () => {
  test('normalizes HTTP origins without query, fragment, or trailing slash', () => {
    expect(normalizeServerUrl(' avi.example.net:7788/ ')).toBe('http://avi.example.net:7788');
    expect(normalizeServerUrl('https://example.test/base///')).toBe('https://example.test/base');
    expect(() => normalizeServerUrl('ftp://example.test')).toThrow('HTTP or HTTPS');
    expect(() => normalizeServerUrl('https://example.test?secret=1')).toThrow('query or fragment');
  });

  test('derives global and encoded conversation WebSocket URLs', () => {
    expect(toWebSocketUrl('https://example.test/base', '/rpc')).toBe('wss://example.test/base/rpc');
    expect(conversationSocketPath('thread / 1')).toBe('/rpc/conversations/streams/thread%20%2F%201');
  });

  test('encodes a UTF-8 key as a base64url subprotocol without padding', () => {
    expect(encodeApiKeyProtocol('clé/+/')).toMatch(/^avi-api-key\.[A-Za-z0-9_-]+$/);
    expect(encodeApiKeyProtocol('clé/+/')).not.toContain('=');
    expect(createAuthProtocols('secret')[0]).toBe('avi-rpc-v1');
  });

  test('requires the supported canonical discovery API version', () => {
    expect(readApiVersion({ versions: { rpc: 1 } })).toBe(1);
    expect(readApiVersion({ versions: { rpc: '1' } })).toBeNull();
    expect(validateDiscovery({ versions: { rpc: 1 }, methods: ['rpc:discover'] }).apiVersion).toBe(1);
    expect(() => validateDiscovery({ apiVersion: 1, methods: [] })).toThrow('Unsupported RPC API version unknown');
    expect(() => validateDiscovery({ versions: { rpc: 2 }, methods: [] })).toThrow('Unsupported RPC API version 2');
    expect(() => validateDiscovery({ versions: { rpc: 1 }, methods: [{ name: 'rpc:discover' }] })).toThrow('invalid RPC method discovery list');
  });

  test('attachment reads contain ownership IDs and reject paths', () => {
    const params = attachmentReadParams({ messageId: 'm1', attachmentId: 'a1' }, 10, 20);
    expect(params).toEqual({ messageId: 'm1', attachmentId: 'a1', offset: 10, limit: 20 });
    expect(JSON.stringify(params)).not.toContain('path');
    expect(() => attachmentReadParams({ messageId: 'm1', attachmentId: 'a1', path: 'C:\\secret' }, 0)).toThrow('caller-supplied paths');
    expect(() => attachmentReadParams({ attachmentId: 'a1' }, 0)).toThrow('messageId');
  });
});
