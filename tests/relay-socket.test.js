import { afterEach, expect, test } from 'bun:test';
import { RelaySocket } from '../src/rpc/relay-socket.js';
import { RpcClient } from '../src/rpc/client.js';

class Socket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  constructor(url, protocols) { super(); Object.assign(this, { url, protocols, protocol: 'avi-relay-v1', readyState: 0, bufferedAmount: 0, sent: [] }); Socket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(data) { this.sent.push(JSON.parse(data)); }
  message(data) { const event = new Event('message'); event.data = JSON.stringify(data); this.dispatchEvent(event); }
  close(code = 1000) { this.readyState = 3; const event = new Event('close'); Object.assign(event, { code }); this.dispatchEvent(event); }
}
const clients = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const ticket = () => ({ ticket: 'a'.repeat(64), expiresAt: Date.now() + 60000, protocol: 'avi-relay-v1', websocketUrl: 'wss://avi-relay.projpw.workers.dev/v1/relays/11111111-1111-1111-1111-111111111111/device/connect' });
const options = { deviceId: 'device', accessToken: 'account-secret', WebSocketImpl: Socket };
afterEach(() => { for (const client of clients.splice(0)) client.close(); Socket.instances = []; });

test('independent consumers wait for Remote ready and send no credential in the handshake', async () => {
  const calls = [];
  for (const path of ['/rpc', '/rpc/conversations/streams/thread']) {
    const relay = new RelaySocket({ ...options, path, fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(ticket()), { status: 201 }); } });
    clients.push(relay);
    await flush();
    const socket = Socket.instances.at(-1);
    socket.open();
    expect(relay.readyState).toBe(0);
    expect(() => relay.send('{}')).toThrow('not ready');
    expect(socket.sent).toEqual([{ type: 'avi-remote-open', version: 2, path }]);
    expect(socket.protocols).toEqual(['avi-relay-v1', `avi-relay-ticket.${'a'.repeat(64)}`]);
    socket.message({ type: 'avi-remote-ready', version: 2 });
    expect(relay.readyState).toBe(1);
    expect(relay.protocol).toBe('avi-rpc-v1');
  }
  expect(Socket.instances).toHaveLength(2);
  expect(calls).toHaveLength(2);
  expect(calls[0].init.headers.Authorization).toBe('Bearer account-secret');
  expect(JSON.parse(calls[0].init.body)).toEqual({ role: 'consumer' });
  clients[1].close();
  expect(clients[0].readyState).toBe(1);
});

test('a legacy or invalid ready frame closes terminally', async () => {
  const relay = new RelaySocket({ ...options, fetchImpl: async () => new Response(JSON.stringify(ticket()), { status: 201 }) });
  clients.push(relay);
  let closed;
  relay.addEventListener('close', (event) => { closed = event; });
  await flush();
  Socket.instances.at(-1).open();
  Socket.instances.at(-1).message({ type: 'avi-remote-ready', version: 1 });
  expect(closed.retryable).toBe(false);
  expect(closed.code).toBe(1008);
});

for (const status of [401, 403]) test(`ticket ${status} is terminal`, async () => {
  const relay = new RelaySocket({ ...options, fetchImpl: async () => new Response('{}', { status }) });
  clients.push(relay);
  let closed;
  relay.addEventListener('close', (event) => { closed = event; });
  await flush();
  expect(closed.retryable).toBe(false);
  expect(Socket.instances).toHaveLength(0);
});

test('rejects ticket URL substitution and cancels stale ticket acquisition', async () => {
  const relay = new RelaySocket({ ...options, fetchImpl: async () => new Response(JSON.stringify({ ...ticket(), websocketUrl: 'wss://evil.example/connect' }), { status: 201 }) });
  clients.push(relay);
  let closed;
  relay.addEventListener('close', (event) => { closed = event; });
  await flush();
  expect(closed.retryable).toBe(false);
  let release;
  const canceled = new RelaySocket({ ...options, fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  clients.push(canceled);
  await flush();
  canceled.close();
  release(new Response(JSON.stringify(ticket()), { status: 201 }));
  await flush();
  expect(Socket.instances).toHaveLength(0);
});

test('pending RPC fails unknown, reconnect gets fresh ticket without replay, Remote rejection stops retry', async () => {
  let tickets = 0;
  const client = new RpcClient({ relay: { deviceId: 'device', accessToken: 'account-secret', fetchImpl: async () => { tickets++; return new Response(JSON.stringify(ticket()), { status: 201 }); } }, WebSocketImpl: Socket });
  clients.push(client);
  const connecting = client.connect();
  await flush();
  const first = Socket.instances.at(-1);
  first.open(); first.message({ type: 'avi-remote-ready', version: 2 });
  await connecting;
  const pending = client.request('chat:send', { text: 'once' }).catch((error) => error);
  first.close(1012);
  expect((await pending).message).toContain('outcome is unknown');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(tickets).toBe(2);
  const second = Socket.instances.at(-1);
  second.open(); second.message({ type: 'avi-remote-ready', version: 2 });
  await flush();
  expect(second.sent).toHaveLength(1);
  second.message({ type: 'avi-remote-error', version: 2, code: 'unauthorized' });
  expect(client.closed).toBe(true);
  expect(client.reconnectTimer).toBeNull();
});

test('heartbeat timeout closes silent consumer and matching pong maintains it', async () => {
  const relay = new RelaySocket({ ...options, heartbeatMs: 5, heartbeatTimeoutMs: 40, fetchImpl: async () => new Response(JSON.stringify(ticket()), { status: 201 }) });
  clients.push(relay);
  await flush();
  const socket = Socket.instances.at(-1);
  socket.open(); socket.message({ type: 'avi-remote-ready', version: 2 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const ping = socket.sent.find((frame) => frame.type === 'avi-remote-ping');
  expect(ping.version).toBe(2);
  socket.message({ type: 'avi-remote-pong', version: 2, id: ping.id });
  expect(relay.readyState).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  expect(relay.readyState).toBe(3);
});
