import { beforeEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { connectionStorageContract, deleteConnection, listConnections, sanitizeConnection, saveConnection } from '../src/storage/connections.js';

let indexedDB;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('connection-only IndexedDB storage', () => {
  test('stores and updates only connection records', async () => {
    const saved = await saveConnection({ label: 'Local', serverUrl: 'localhost:7788/', apiKey: 'secret' }, indexedDB);
    expect(saved.serverUrl).toBe('http://localhost:7788');
    expect(await listConnections(indexedDB)).toEqual([saved]);
    const updated = await saveConnection({ ...saved, label: 'Workstation' }, indexedDB);
    expect(updated.label).toBe('Workstation');
    expect(updated.createdAt).toBe(saved.createdAt);
    await deleteConnection(saved.id, indexedDB);
    expect(await listConnections(indexedDB)).toEqual([]);
  });

  test('rejects drafts, layout, theme, active state, caches, and remote data', () => {
    for (const field of ['draftText', 'sidebarWidth', 'theme', 'activeConversationId', 'messages', 'cache']) {
      expect(() => sanitizeConnection({ label: 'Bad', serverUrl: 'localhost', apiKey: 'key', [field]: true })).toThrow('unsupported fields');
    }
    expect(connectionStorageContract.allowedFields).toEqual(['id', 'label', 'serverUrl', 'apiKey', 'createdAt', 'updatedAt']);
  });
});
