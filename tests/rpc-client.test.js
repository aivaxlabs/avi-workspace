import { describe, expect, test } from 'bun:test';
import { RpcClient, RpcError } from '../src/rpc/client.js';
import { controlFrame } from '../src/rpc/orpc.js';
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

  test('acknowledges and drops an expired event without closing the channel', async () => {
    const { client, socket } = await connectClient();
    const errors = [];
    const notifications = [];
    const stale = [];
    client.addEventListener('protocol-error', (event) => errors.push(event.detail));
    client.addEventListener('notification', (event) => notifications.push(event.detail));
    client.addEventListener('stale-event', (event) => stale.push(event.detail));
    socket.message(await eventFrame('conversation.event', { sequence: 7 }, { eventId: 'evt-x', expiresAt: Date.now() - 1, id: 'stale1' }));
    await until(() => socket.rawSent.some((wire) => decodeWireFrame(wire).type === 'RES' && decodeWireFrame(wire).baseId === 'stale1' && !decodeWireFrame(wire).control));
    expect(socket.readyState).toBe(1);
    expect(errors).toEqual([]);
    expect(notifications).toEqual([]);
    expect(stale).toEqual([{ method: 'conversation:event' }]);
    await closeClient(client);
  });

  test('resume keeps a live socket and replaces a socket that stops answering pings', async () => {
    const { client, socket } = await connectClient({ reconnect: true });
    await expect(client.resume()).resolves.toBe(client);
    expect(client.socket).toBe(socket);
    const stalled = client.socket;
    stalled.deliver = () => {};
    client.peer.limits.attemptMs = 60_000;
    const original = client.peer.ping.bind(client.peer);
    client.peer.ping = () => original(40);
    const statuses = [];
    client.addEventListener('status', (event) => statuses.push(event.detail.status));
    const resumed = client.resume();
    await until(() => FakeSocket.instances.at(-1) !== stalled, 4000);
    await expect(resumed).resolves.toBe(client);
    expect(stalled.readyState).toBe(3);
    expect(client.socket.readyState).toBe(1);
    expect(statuses).toEqual(['offline', 'checking', 'online']);
    expect(client.reconnectAttempt).toBe(0);
    await closeClient(client);
  });

  test('resume probes a live socket with the production 5 s deadline', async () => {
    const { client } = await connectClient({ reconnect: true });
    const deadlines = [];
    const original = client.peer.ping.bind(client.peer);
    client.peer.ping = (timeoutMs) => { deadlines.push(timeoutMs); return original(timeoutMs); };
    await expect(client.resume()).resolves.toBe(client);
    expect(deadlines).toEqual([5_000]);
    expect(FakeSocket.instances).toHaveLength(1);
    await closeClient(client);
  });

  test('a pending resume probe does not resurrect a client closed meanwhile', async () => {
    const { client, socket } = await connectClient({ reconnect: true });
    const deliver = socket.deliver.bind(socket);
    socket.deliver = (frame) => { if (!decodeWireFrame(frame).id.endsWith('#PONG')) deliver(frame); };
    const original = client.peer.ping.bind(client.peer);
    client.peer.ping = () => original(40);
    const resumed = client.resume();
    await closeClient(client);
    await expect(resumed).resolves.toBe(client);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(client.closed).toBe(true);
    expect(client.disposed).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('a pending resume probe stays terminal after an authentication rejection', async () => {
    const { client, socket } = await connectClient({ reconnect: true });
    socket.deliver = () => {};
    const resumed = client.resume();
    socket.close(4003, 'Unauthorized');
    await expect(resumed).resolves.toBe(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.closed).toBe(true);
    expect(client.reconnectTimer).toBeNull();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('a natural close during a resume probe fails once and reconnects with a single new socket', async () => {
    const { client, socket } = await connectClient({ reconnect: true });
    socket.deliver = () => {};
    const closes = [];
    client.addEventListener('close', (event) => closes.push(event.detail.code));
    const resumed = client.resume();
    socket.close(1006, 'Network changed');
    await expect(resumed).resolves.toBe(client);
    expect(closes).toEqual([1006]);
    expect(client.failures).toBe(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.socket).toBe(FakeSocket.instances.at(-1));
    expect(client.socket.readyState).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeSocket.instances).toHaveLength(2);
    await closeClient(client);
  });

  test('recovers automatically from a protocol rejection with a fresh peer', async () => {
    const { client, socket } = await connectClient({ reconnect: true });
    const previousPeer = client.peer;
    socket.close(1002, 'protocol');
    expect(client.closed).toBe(false);
    expect(previousPeer.closed).toBe(true);
    expect(client.reconnectTimer).not.toBeNull();
    expect(client.reconnectAttempt).toBeGreaterThanOrEqual(3);
    clearTimeout(client.reconnectTimer);
    client.reconnectTimer = null;
    await client.connect();
    expect(client.peer).not.toBe(previousPeer);
    const pending = client.request('rpc:discover', {});
    const fresh = FakeSocket.instances.at(-1);
    await until(() => fresh.sent.length === 1);
    fresh.message({ id: fresh.sent[0].id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
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

  test('continues reconnecting after consecutive failed connection attempts until explicitly closed', async () => {
    const { client, socket } = await connectClient({ reconnect: true });
    try {
      client.WebSocketImpl = ManualSocket;
      socket.close(1006, 'offline');
      for (let attempt = 0; attempt < 2; attempt++) {
        const previous = client.socket;
        await until(() => client.socket !== previous, 4000);
        client.socket.close(1006, 'still offline');
        expect(client.closed).toBe(false);
      }
      await until(() => ManualSocket.instances.length >= 4, 8000);
      expect(client.socket.readyState).toBe(0);
      const pending = client.socket;
      await closeClient(client);
      expect(client.reconnectTimer).toBeNull();
      expect(pending.readyState).toBe(3);
    } finally { await closeClient(client); }
  }, 12_000);

  test('reconnects after repeated clean disconnects and restores requests', async () => {
    const { client, socket: first } = await connectClient({ reconnect: true });
    for (const code of [1000, 1001]) {
      const previous = client.socket;
      previous.close(code, 'connection lost');
      await until(() => client.socket !== previous, 4000);
      await until(() => client.socket.readyState === 1);
      expect(client.closed).toBe(false);
    }
    expect(client.socket).not.toBe(first);
    const request = client.request('rpc:discover', {});
    await until(() => client.socket.sent.length === 1);
    client.socket.message({ id: client.socket.sent[0].id, result: 'restored' });
    await expect(request).resolves.toBe('restored');
    await closeClient(client);
  });

  test('recreates the closed ORPC peer after remote shutdown', async () => {
    const { client, socket } = await connectClient({ reconnect: true });
    const previousPeer = client.peer;
    socket.message(controlFrame('REQ', '#EXIT'));
    await until(() => client.peer.closed && socket.readyState === 3);
    await until(() => client.socket !== socket, 4000);
    await until(() => client.socket.readyState === 1);
    expect(client.peer).not.toBe(previousPeer);
    const request = client.request('rpc:discover', {});
    await until(() => client.socket.sent.length === 1);
    client.socket.message({ id: client.socket.sent[0].id, result: 'restored' });
    await expect(request).resolves.toBe('restored');
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

  test('connectUntilReady resolves on open without a second connection', async () => {
    FakeSocket.instances.length = 0;
    const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: ManualSocket });
    try {
      const ready = client.connectUntilReady();
      ManualSocket.instances.at(-1).open();
      await expect(ready).resolves.toBe(client);
      await expect(client.connectUntilReady()).resolves.toBe(client);
      expect(ManualSocket.instances).toHaveLength(1);
    } finally { await closeClient(client); }
  });

  test('connectUntilReady with a small timeout rejects but leaves auto reconnect active', async () => {
    FakeSocket.instances.length = 0;
    const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'key', reconnect: true, WebSocketImpl: ManualSocket });
    try {
      await expect(client.connectUntilReady({ timeoutMs: 30 })).rejects.toMatchObject({ code: 'INCOMPLETE' });
      expect(client.closed).toBe(false);
      client.socket.close(1006, 'still offline');
      expect(client.reconnectTimer).not.toBeNull();
      await until(() => ManualSocket.instances.length >= 2, 4000);
      expect(client.closed).toBe(false);
    } finally { await closeClient(client); }
  }, 10_000);

  test('connectUntilReady rejects CANCELLED on explicit close and schedules nothing', async () => {
    FakeSocket.instances.length = 0;
    const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'key', reconnect: true, WebSocketImpl: ManualSocket });
    try {
      const ready = client.connectUntilReady();
      const pending = ready.catch((error) => error);
      await closeClient(client);
      await expect(pending).resolves.toMatchObject({ code: 'CANCELLED' });
      expect(client.disposed).toBe(true);
      expect(client.reconnectTimer).toBeNull();
    } finally { await closeClient(client); }
  });

  test('connectUntilReady rejects when WebSocket is unavailable', async () => {
    const client = new RpcClient({ url: 'ws://localhost/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: null });
    await expect(client.connectUntilReady()).rejects.toThrow('WebSocket is unavailable');
  });

  test('manual connect after terminal 4003 recreates the peer and requests succeed', async () => {
    const { client, socket } = await connectClient({ reconnect: false });
    const previousPeer = client.peer;
    socket.close(4003, 'forbidden');
    expect(client.closed).toBe(true);
    expect(previousPeer.closed).toBe(true);
    expect(client.reconnectTimer).toBeNull();
    await client.connect();
    const revived = FakeSocket.instances.at(-1);
    expect(revived).not.toBe(socket);
    expect(client.peer).not.toBe(previousPeer);
    const pending = client.request('rpc:discover', {});
    await until(() => revived.sent.length === 1);
    revived.message({ id: revived.sent[0].id, result: { apiVersion: 1 } });
    await expect(pending).resolves.toEqual({ apiVersion: 1 });
    await closeClient(client);
  });

  test('one transient failure sets no problem but three consolidate status.problem', async () => {
    const { client, socket } = await connectClient({ reconnect: false });
    try {
      socket.close(1006, 'transient');
      expect(client.failures).toBe(1);
      expect(client.status.status).toBe('offline');
      expect(client.status.problem).toBe(false);
      client.handleClose(Object.assign(new Event('close'), { code: 1006, reason: 'transient' }));
      expect(client.status.problem).toBe(false);
      client.handleClose(Object.assign(new Event('close'), { code: 1006, reason: 'transient' }));
      expect(client.failures).toBe(3);
      expect(client.status.problem).toBe(true);
    } finally { await closeClient(client); }
  });
});
