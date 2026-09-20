import { describe, expect, test } from 'bun:test';
import { RpcClient, RpcError } from '../src/rpc/client.js';
import { ORPC_PROTOCOL, FakeSocket, decodeWireFrame, eventFrame, utf8Bytes, until } from './orpc-test-helpers.js';

const SECOND = 1000;

class ManualSocket extends FakeSocket {
  constructor(url, protocols) { super(url, protocols, { autoOpen: false }); }
}

async function connectClient(options = {}) {
  FakeSocket.instances.length = 0;
  const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'secret key', reconnect: false, WebSocketImpl: FakeSocket, ...options });
  await client.connect();
  return { client, socket: FakeSocket.instances.at(-1) };
}

async function closeClient(client) {
  await client.close();
}

describe('RpcClient over ORPC Draft 2', () => {
  test('requires the avi-orpc-draft2 subprotocol and keeps the API key out of the URL', async () => {
    FakeSocket.instances.length = 0;
    const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'secret key', reconnect: false, WebSocketImpl: FakeSocket });
    await expect(client.connect()).resolves.toBe(client);
    const socket = FakeSocket.instances.at(-1);
    expect(ORPC_PROTOCOL).toBe('avi-orpc-draft2');
    expect(socket.protocols[0]).toBe(ORPC_PROTOCOL);
    expect(socket.protocols[1]).toStartWith('avi-api-key.');
    expect(socket.url).not.toContain('secret');
    await closeClient(client);

    const rejected = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: ManualSocket });
    const rejectedConnect = rejected.connect();
    ManualSocket.instances.at(-1).open('avi-rpc-v1');
    await expect(rejectedConnect).rejects.toThrow('unsupported WebSocket protocol');
    await closeClient(rejected);
  });

  test('rejects deterministically when the socket closes before opening', async () => {
    const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: ManualSocket });
    const connecting = client.connect();
    ManualSocket.instances.at(-1).close(1006, 'refused');
    await expect(connecting).rejects.toThrow('refused');
    expect(client.connectPromise).toBeNull();
  });

  test('sends multipart-capable REQ with hash checksum and correlates the JSON result', async () => {
    const { client, socket } = await connectClient();
    const pending = client.request('rpc:discover', { compact: true });
    await until(() => socket.sent.length === 1);
    expect(socket.rawSent).toHaveLength(2);

    const wire = new TextDecoder().decode(socket.rawSent[0]);
    const prefixLength = wire.indexOf(' ');
    expect(Number(wire.slice(0, prefixLength))).toBe(new TextEncoder().encode(wire.slice(prefixLength + 1)).length);
    expect(wire.slice(prefixLength + 1)).toStartWith(`ORPC/1 REQ${socket.sent[0].id} rpc.discover 1 1\n`);

    const check = decodeWireFrame(socket.rawSent[1]);
    expect(check.type).toBe('REQ');
    expect(check.baseId).toBe(socket.sent[0].id);
    expect(check.control).toBe('CHECKSEND');
    expect(check.text).toMatch(/^sha256:[0-9a-f]{64}$/);

    const request = socket.sent[0];
    const now = Date.now();
    expect(request.id).toMatch(/^[0-9a-f]{32}$/);
    expect(request.json.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.json.expiresAt).toBeGreaterThan(now + 170 * SECOND);
    expect(request.json.params).toEqual({ compact: true });

    socket.message({ id: request.id, result: { apiVersion: 1 } });
    await expect(pending).resolves.toEqual({ apiVersion: 1 });
    expect(client.metrics.sentBytes).toBe(socket.rawSent.reduce((total, raw) => total + raw.byteLength, 0));
    expect(client.metrics.receivedBytes).toBeGreaterThan(0);
    expect(client.metrics.completed).toBe(1);
    expect(client.metrics.failed).toBe(0);
    expect(client.metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(client.metrics.lastResponseAt).toBeGreaterThan(0);
    const firstLatency = client.metrics.latencyMs;
    expect(client.metrics.latencyMinMs).toBe(firstLatency);
    expect(client.metrics.latencyMaxMs).toBe(firstLatency);
    expect(client.metrics.latencyTotalMs).toBe(firstLatency);

    const next = client.request('rpc:discover', {});
    await until(() => socket.sent.length === 2);
    socket.message({ id: socket.sent[1].id, result: {} });
    await next;
    const secondLatency = client.metrics.latencyMs;
    expect(client.metrics.completed).toBe(2);
    expect(client.metrics.latencyMinMs).toBe(Math.min(firstLatency, secondLatency));
    expect(client.metrics.latencyMaxMs).toBe(Math.max(firstLatency, secondLatency));
    expect(client.metrics.latencyTotalMs).toBe(firstLatency + secondLatency);
    await closeClient(client);
  });

  test('maps an error payload to RpcError with code and data', async () => {
    const { client, socket } = await connectClient();
    const pending = client.request('chat:send', { text: 'hi' });
    await until(() => socket.sent.length === 1);
    socket.message({ id: socket.sent[0].id, error: { code: 'METHOD_NOT_FOUND', message: 'Method not found', data: { retryable: false } } });
    await expect(pending).rejects.toBeInstanceOf(RpcError);
    await expect(pending).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND', message: 'Method not found', data: { retryable: false } });
    await closeClient(client);
  });

  test('correlates concurrent requests independently of response order', async () => {
    const { client, socket } = await connectClient();
    const first = client.request('conversations:list', {});
    const second = client.request('models:list', {});
    await until(() => socket.sent.length === 2);
    const [a, b] = socket.sent;
    expect(a.id).not.toBe(b.id);
    socket.message({ id: b.id, result: { models: [] } });
    socket.message({ id: a.id, result: [] });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual({ models: [] });
    await closeClient(client);
  });

  test('acks server events with hash-verified responses, deduplicates redeliveries, maps dotted methods', async () => {
    const { client, socket } = await connectClient();
    const notifications = [];
    client.addEventListener('notification', (event) => notifications.push(event.detail));
    const expiresAt = Date.now() + 60 * SECOND;
    socket.message(await eventFrame('conversation.ready', { sequence: 1 }, { eventId: 'evt-1', expiresAt, id: 'srvreq1' }));
    await until(() => socket.rawSent.length === 3);
    const ack = socket.rawSent.map(decodeWireFrame).find((frame) => frame.type === 'RES' && !frame.control);
    expect(ack.type).toBe('RES');
    expect(ack.id).toBe('srvreq1');
    expect(ack.final).toBe(true);
    expect(ack.text).toBe('OK');
    const ackCheck = socket.rawSent.map(decodeWireFrame).find((frame) => frame.type === 'RES' && frame.control === 'CHECKOK');
    expect(ackCheck?.baseId).toBe('srvreq1');
    expect(ackCheck.text).toBe('');
    expect(notifications).toEqual([{ method: 'conversation:ready', params: { sequence: 1 } }]);

    socket.message(await eventFrame('conversation.ready', { sequence: 1 }, { eventId: 'evt-1', expiresAt, id: 'srvreq2' }));
    await until(() => socket.rawSent.filter((raw) => !decodeWireFrame(raw).control).length === 2);
    expect(socket.rawSent.map(decodeWireFrame).filter((frame) => frame.type === 'RES' && !frame.control).at(-1).text).toBe('OK');
    expect(notifications).toEqual([{ method: 'conversation:ready', params: { sequence: 1 } }]);
    await closeClient(client);
  });

  test('closes the channel on an expired event', async () => {
    const { client, socket } = await connectClient();
    const errors = [];
    client.addEventListener('protocol-error', (event) => errors.push(event.detail));
    socket.message(await eventFrame('conversation.ready', { sequence: 1 }, { eventId: 'evt-x', expiresAt: Date.now() - 1 }));
    await until(() => socket.readyState === 3);
    expect(errors.map((error) => `${error.code}: ${error.message}`)).toEqual(['PROTOCOL: Invalid or expired event']);
    await closeClient(client);
  });

  test('closes the channel on a conflicting event identifier', async () => {
    const { client, socket } = await connectClient();
    const errors = [];
    client.addEventListener('protocol-error', (event) => errors.push(event.detail));
    socket.message(await eventFrame('conversation.ready', { sequence: 1 }, { eventId: 'evt-1', expiresAt: Date.now() + 60 * SECOND, id: 'req1' }));
    await until(() => socket.rawSent.some((wire) => {
      const frame = decodeWireFrame(wire);
      return frame.type === 'RES' && frame.id === 'req1#CHECKSEND';
    }));
    socket.message(await eventFrame('conversation.ready', { sequence: 2 }, { eventId: 'evt-1', expiresAt: Date.now() + 60 * SECOND, id: 'req2' }));
    await until(() => socket.readyState === 3);
    expect(errors.map((error) => error.message)).toEqual(['Conflicting event identifier']);
    await closeClient(client);
  });

  test('retries after an attempt timeout with a fresh frame id and the identical envelope', async () => {
    const { client, socket } = await connectClient({ timeoutMs: 400 });
    const pending = client.request('chat:send', { text: 'hello' });
    await until(() => socket.sent.length === 1);
    const first = socket.sent[0];
    await until(() => socket.sent.length === 2);
    const second = socket.sent[1];
    expect(second.id).not.toBe(first.id);
    expect(second.method).toBe(first.method);
    expect(second.text).toBe(first.text);
    socket.message({ id: second.id, result: 'delivered' });
    await expect(pending).resolves.toBe('delivered');
    await closeClient(client);
  });

  test('rejects once both attempts time out without a response', async () => {
    const { client, socket } = await connectClient({ timeoutMs: 25 });
    await expect(client.request('chat:send', {})).rejects.toThrow('Incomplete delivery: recovery budget or overall deadline exhausted');
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1].id).not.toBe(socket.sent[0].id);
    await closeClient(client);
  });

  test('retries across a reconnection with a fresh id and the identical envelope', async () => {
    const { client, socket: firstSocket } = await connectClient({ reconnect: true });
    Object.assign(client.peer.limits, { overallMs: 8000, backoffMs: 1 });
    const pending = client.request('chat:send', { text: 'survive' });
    await until(() => firstSocket.sent.length === 1);
    const first = firstSocket.sent[0];
    firstSocket.close(1006, 'dropped');
    await until(() => FakeSocket.instances.length >= 2, 4000);
    const secondSocket = FakeSocket.instances.at(-1);
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.open();
    await until(() => secondSocket.sent.length === 1, 4000);
    const second = secondSocket.sent[0];
    expect(second.id).not.toBe(first.id);
    expect(second.text).toBe(first.text);
    secondSocket.message({ id: second.id, result: 'recovered' });
    await expect(pending).resolves.toBe('recovered');
    await closeClient(client);
  });

  test('explicit cancellation rejects without retrying', async () => {
    const { client, socket } = await connectClient();
    const controller = new AbortController();
    const pending = client.request('chat:send', {}, { signal: controller.signal });
    await until(() => socket.sent.length === 1);
    controller.abort(new Error('user requested'));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(socket.sent).toHaveLength(1);
    await closeClient(client);
  });

  test('an already-aborted signal rejects before sending anything', async () => {
    const { client, socket } = await connectClient();
    await expect(client.request('chat:send', {}, { signal: AbortSignal.abort('nope') })).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.sent).toHaveLength(0);
    await closeClient(client);
  });

  test('terminates the peer and fails pending requests on a malformed frame', async () => {
    const { client, socket } = await connectClient();
    Object.assign(client.peer.limits, { attemptMs: 50, overallMs: 500, backoffMs: 1 });
    const errors = [];
    client.addEventListener('protocol-error', (event) => errors.push(event.detail));
    const pending = client.request('chat:send', {}, { timeoutMs: 50 });
    pending.catch(() => {});
    await until(() => socket.sent.length === 1);
    socket.message(utf8Bytes('garbage frame'));
    await until(() => socket.readyState === 3);
    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(errors).toHaveLength(1);
    await closeClient(client);
  });

  test('withholds server events until the integrity checksum validates', async () => {
    const { client, socket } = await connectClient();
    const notifications = [];
    client.addEventListener('notification', (event) => notifications.push(event.detail.params.sequence));
    const frames = await eventFrame('conversation.ready', { sequence: 1 }, { eventId: 'evt-1', expiresAt: Date.now() + 60 * SECOND });
    socket.message(frames.slice(0, -1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications).toEqual([]);
    expect(socket.rawSent).toHaveLength(0);
    socket.message(frames.at(-1));
    await until(() => notifications.length === 1);
    expect(notifications).toEqual([1]);
    await closeClient(client);
  });

  test('processes asynchronously decoded transfers in arrival order', async () => {
    const { client, socket } = await connectClient();
    const notifications = [];
    client.addEventListener('notification', (event) => notifications.push(event.detail.params.sequence));
    const first = await eventFrame('conversation.ready', { sequence: 1 }, { eventId: 'evt-1', expiresAt: Date.now() + 60 * SECOND });
    const second = await eventFrame('conversation.ready', { sequence: 2 }, { eventId: 'evt-2', expiresAt: Date.now() + 60 * SECOND });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const delayed = new Blob([]);
    delayed.arrayBuffer = async () => {
      await gate;
      return first[0];
    };
    socket.message(delayed);
    socket.message(second.slice(0, -1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications).toEqual([]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications).toEqual([]);
    socket.message([first[1], second[1]]);
    await until(() => notifications.length === 2);
    expect(notifications).toEqual([1, 2]);
    await closeClient(client);
  });

  test('drops a frame that finishes decoding after the socket is closed', async () => {
    const { client, socket } = await connectClient();
    const notifications = [];
    client.addEventListener('notification', (event) => notifications.push(event.detail));
    const frames = await eventFrame('conversation.ready', { sequence: 1 }, { eventId: 'evt-1', expiresAt: Date.now() + 60 * SECOND });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const delayed = new Blob([]);
    delayed.arrayBuffer = async () => {
      await gate;
      return frames[0];
    };
    socket.message(delayed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await closeClient(client);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications).toEqual([]);
  });

  test('ignores a late close from a replaced socket', async () => {
    FakeSocket.instances.length = 0;
    const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    const firstSocket = FakeSocket.instances.at(-1);
    await connecting;
    firstSocket.readyState = 3;
    const secondConnect = client.connect();
    const secondSocket = FakeSocket.instances.at(-1);
    await expect(secondConnect).resolves.toBe(client);
    const pending = client.request('chat:send', {});
    await until(() => secondSocket.sent.length === 1);
    firstSocket.close(1006, 'late close');
    secondSocket.message({ id: secondSocket.sent[0].id, result: 'ok' });
    await expect(pending).resolves.toBe('ok');
    await closeClient(client);
  });

  test('close performs the EXIT/BYE handshake before the socket closes', async () => {
    const { client, socket } = await connectClient();
    await closeClient(client);
    expect(socket.readyState).toBe(3);
    expect(client.peer.closed).toBe(true);
  });
});
