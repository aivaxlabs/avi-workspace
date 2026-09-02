import { beforeEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { connectionStorageContract, deleteConnection, listConnections, saveConnection } from '../src/storage/connections.js';

let indexedDB;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('connection-only IndexedDB storage', () => {
  test('persists only the declared connection fields', async () => {
    const saved = await saveConnection({ label: 'Local', serverUrl: 'localhost:18992', apiKey: 'key' }, indexedDB);
    expect(Object.keys(saved).sort()).toEqual([...connectionStorageContract.allowedFields].sort());
    expect((await listConnections(indexedDB))[0].apiKey).toBe('key');
  });

  test('rejects messages, drafts, layout, and other remote state', async () => {
    await expect(saveConnection({ serverUrl: 'localhost:18992', apiKey: 'key', messages: [] }, indexedDB)).rejects.toThrow('unsupported fields');
    await expect(saveConnection({ serverUrl: 'localhost:18992', apiKey: 'key', theme: 'dark' }, indexedDB)).rejects.toThrow('unsupported fields');
  });

  test('deletes only the local connection record', async () => {
    const saved = await saveConnection({ serverUrl: 'localhost:18992', apiKey: 'key' }, indexedDB);
    await deleteConnection(saved.id, indexedDB);
    expect(await listConnections(indexedDB)).toEqual([]);
  });
});
