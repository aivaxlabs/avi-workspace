// Real-socket relay end-to-end check: drives the actual RelaySocket/RpcClient against a local
// v3 Desktop-side contract peer (avi-remote v3 handshake + binary ORPC frames) over real
// WebSockets with the real ticket flow.
// Run: bun scripts/test-relay-e2e.mjs
// Runs in its own process on purpose: DOM tests replace globalThis.WebSocket in `bun test`.
import { strict as assert } from 'node:assert';
import { RelaySocket } from '../src/rpc/relay-socket.js';
import { RpcClient } from '../src/rpc/client.js';
import { AIVAX_RELAYS_URL } from '../src/rpc/aivax.js';
import { ORPC_PROTOCOL, parseFrame, responseFrames } from '../src/rpc/orpc.js';

const TICKET_URL_PATH = '/v1/relays/11111111-1111-1111-1111-111111111111/device42/connect';
const DEVICE_ID = 'device42';
const ACCESS_TOKEN = 'aivax-session-token';

function startRelayPeer() {
  const state = { opens: [], requests: [], tickets: [] };
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === TICKET_URL_PATH) {
        const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((value) => value.trim());
        const offered = protocols.find((value) => value.startsWith('avi-relay-ticket.'));
        if (!offered || protocols[0] !== 'avi-relay-v1') return new Response('relay subprotocol mismatch', { status: 400 });
        const accepted = server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'avi-relay-v1' }, data: { ticket: offered.slice('avi-relay-ticket.'.length) } });
        if (!accepted) return new Response('upgrade failed', { status: 400 });
        return undefined;
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        if (typeof raw === 'string') {
          const frame = JSON.parse(raw);
          if (frame.type === 'avi-remote-open') {
            state.opens.push(frame);
            // Desktop v3 contract: the open frame names the ORPC protocol and carries no
            // credential; anything else is rejected without a ready frame.
            if (frame.version !== 3 || frame.protocol !== ORPC_PROTOCOL || 'apiKey' in frame) {
              ws.send(JSON.stringify({ type: 'avi-remote-error', version: 3, code: 'unauthorized' }));
              return;
            }
            ws.send(JSON.stringify({ type: 'avi-remote-ready', version: 3, protocol: ORPC_PROTOCOL }));
            return;
          }
          if (frame.type === 'avi-remote-ping') {
            ws.send(JSON.stringify({ type: 'avi-remote-pong', version: 3, id: frame.id }));
            return;
          }
          return;
        }
        // Binary messages carry exactly one length-prefixed ORPC frame.
        let parsed;
        try { parsed = parseFrame(new Uint8Array(raw)); } catch { ws.close(1002, 'invalid orpc frame'); return; }
        if (parsed.type !== 'REQ') return;
        state.requests.push(parsed.method);
        const request = JSON.parse(new TextDecoder().decode(parsed.content));
        const result = parsed.method === 'rpc.discover'
          ? { methods: ['rpc.discover'], appVersion: '0.0.0-test', versions: { rpc: 1 } }
          : { ok: true, method: parsed.method };
        const content = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: request.operationId, result }));
        for (const frame of responseFrames(parsed.id, crypto.randomUUID(), content)) ws.send(Buffer.from(frame));
      },
    },
  });
  // RelaySocket hard-validates the ticket URL against wss + AIVAX_RELAYS_URL host, so the harness
  // maps that host onto the local peer inside WebSocketImpl instead of changing client code.
  const localOrigin = `ws://127.0.0.1:${server.port}`;
  class WebSocketImpl extends WebSocket {
    constructor(url, protocols) { super(String(url).replace(/^wss:\/\/avi-relay\.projpw\.workers\.dev/, localOrigin), protocols); }
  }
  const fetchImpl = async (url, init) => {
    state.tickets.push({ url: String(url), authorization: init.headers.Authorization, body: JSON.parse(init.body) });
    return Response.json({ ticket: 'a'.repeat(64), expiresAt: Date.now() + 60_000, protocol: 'avi-relay-v1', websocketUrl: `wss://avi-relay.projpw.workers.dev${TICKET_URL_PATH}` }, { status: 201 });
  };
  return { state, WebSocketImpl, fetchImpl, stop: () => server.stop(true) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function testRelaySocketHandshake() {
  const peer = startRelayPeer();
  try {
    const relay = new RelaySocket({ deviceId: DEVICE_ID, accessToken: ACCESS_TOKEN, path: '/rpc', WebSocketImpl: peer.WebSocketImpl, fetchImpl: peer.fetchImpl });
    let closed = null;
    relay.addEventListener('close', (event) => { closed = event; });
    await new Promise((resolve, reject) => {
      relay.addEventListener('open', resolve);
      relay.addEventListener('close', () => reject(new Error('relay closed before opening')));
    });
    assert.equal(relay.readyState, 1);
    assert.equal(relay.protocol, ORPC_PROTOCOL);
    assert.deepEqual(peer.state.tickets, [{ url: `${AIVAX_RELAYS_URL}/${DEVICE_ID}/tickets`, authorization: `Bearer ${ACCESS_TOKEN}`, body: { role: 'consumer' } }]);
    assert.deepEqual(peer.state.opens, [{ type: 'avi-remote-open', version: 3, protocol: ORPC_PROTOCOL, path: '/rpc' }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(closed, null, 'relay stayed open across a heartbeat tick');
    relay.close();
    assert.equal(closed.code, 1000);
    console.log('(pass) RelaySocket completes the keyless v3+protocol handshake over a real socket and heartbeats');
  } finally { peer.stop(); }
}

async function testRpcClientOverRelay() {
  const peer = startRelayPeer();
  try {
    const client = new RpcClient({ relay: { deviceId: DEVICE_ID, accessToken: ACCESS_TOKEN, fetchImpl: peer.fetchImpl }, reconnect: false, WebSocketImpl: peer.WebSocketImpl });
    try {
      await client.connect();
      const discovery = await client.request('rpc:discover').catch(() => null);
      assert.notEqual(discovery, null);
      assert.deepEqual(peer.state.opens, [{ type: 'avi-remote-open', version: 3, protocol: ORPC_PROTOCOL, path: '/rpc' }]);
      assert.ok(peer.state.requests.includes('rpc.discover'), 'discovery must travel as a dotted wire method in an ORPC frame');
      assert.deepEqual(discovery, { methods: ['rpc.discover'], appVersion: '0.0.0-test', versions: { rpc: 1 } });
    } finally { await flush(); client.close(); }
    await flush();
    console.log('(pass) RpcClient opens relay sessions and completes binary ORPC RPC over the real socket');
  } finally { peer.stop(); }
}

try {
  await testRelaySocketHandshake();
  await testRpcClientOverRelay();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
