import { normalizeServerUrl } from '../rpc/url.js';

const DATABASE_NAME = 'avi-workspace-connections';
const DATABASE_VERSION = 2;
const ACCOUNT_STORE = 'aivax-account';
const STORE_NAME = 'connections';
const ALLOWED_FIELDS = new Set(['id', 'label', 'serverUrl', 'apiKey', 'createdAt', 'updatedAt']);

function openDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) throw new Error('IndexedDB is unavailable in this browser.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(ACCOUNT_STORE)) database.createObjectStore(ACCOUNT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open connection storage.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Connection storage request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error('Connection storage transaction aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Connection storage transaction failed.'));
  });
}

export function sanitizeConnection(input, existing = null) {
  const unknown = Object.keys(input ?? {}).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw new Error(`Connection storage rejected unsupported fields: ${unknown.join(', ')}.`);
  const now = new Date().toISOString();
  const apiKey = String(input?.apiKey ?? existing?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('API key is required.');
  const serverUrl = normalizeServerUrl(input?.serverUrl ?? existing?.serverUrl);
  return {
    id: String(input?.id || existing?.id || crypto.randomUUID()),
    label: String(input?.label ?? existing?.label ?? '').trim() || new URL(serverUrl).host,
    serverUrl,
    apiKey,
    createdAt: existing?.createdAt ?? input?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function listConnections(indexedDB) {
  const database = await openDatabase(indexedDB);
  try {
    const records = await requestResult(database.transaction(STORE_NAME).objectStore(STORE_NAME).getAll());
    return records.sort((left, right) => left.label.localeCompare(right.label));
  } finally {
    database.close();
  }
}

export async function saveConnection(input, indexedDB) {
  const database = await openDatabase(indexedDB);
  try {
    const readTransaction = database.transaction(STORE_NAME);
    const existing = input?.id != null ? await requestResult(readTransaction.objectStore(STORE_NAME).get(input.id)) : null;
    const record = sanitizeConnection(input, existing);
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    if (existing && existing.id !== record.id) transaction.objectStore(STORE_NAME).delete(existing.id);
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
    return record;
  } finally {
    database.close();
  }
}

export async function deleteConnection(id, indexedDB) {
  const database = await openDatabase(indexedDB);
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function loadAivaxAccessToken() {
  const database = await openDatabase();
  try {
    return await requestResult(database.transaction(ACCOUNT_STORE).objectStore(ACCOUNT_STORE).get('accessToken')) || '';
  } finally {
    database.close();
  }
}

export async function saveAivaxAccessToken(token) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ACCOUNT_STORE, 'readwrite');
    const store = transaction.objectStore(ACCOUNT_STORE);
    if (token) store.put(token, 'accessToken');
    else store.delete('accessToken');
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export const connectionStorageContract = Object.freeze({
  databaseName: DATABASE_NAME,
  storeName: STORE_NAME,
  allowedFields: Object.freeze([...ALLOWED_FIELDS]),
});
