// Real-socket relay end-to-end check: drives the actual RelaySocket/RpcClient against a local
// v2 relay peer (the Desktop-side contract) over real WebSockets with the real ticket flow.
// Run: bun scripts/test-relay-e2e.mjs
// Runs in its own process on purpose: DOM tests replace globalThis.WebSocket in `bun test`.
import { strict as assert } from 'node:assert';
import { RelaySocket } from '../src/rpc/relay-socket.js';
import { RpcClient } from '../src/rpc/client.js';
import { AIVAX_RELAYS_URL } from '../src/rpc/aivax.js';

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
        const frame = JSON.parse(String(raw));
        if (frame.type === 'avi-remote-open') {
          state.opens.push(frame);
          // Desktop v2 contract: the open frame carries no credential; anything else is rejected.
          if (frame.version !== 2 || 'apiKey' in frame) {
            ws.send(JSON.stringify({ type: 'avi-remote-error', version: 2, code: 'unauthorized' }));
            return;
          }
          ws.send(JSON.stringify({ type: 'avi-remote-ready', version: 2 }));
          return;
        }
        if (frame.type === 'avi-remote-ping') {
          ws.send(JSON.stringify({ type: 'avi-remote-pong', version: 2, id: frame.id }));
          return;
        }
        if (frame.method) {
          state.requests.push(frame.method);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { methods: ['rpc:discover'], appVersion: '0.0.0-test', versions: { rpc: 1 } } }));
        }
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
    assert.deepEqual(peer.state.tickets, [{ url: `${AIVAX_RELAYS_URL}/${DEVICE_ID}/tickets`, authorization: `Bearer ${ACCESS_TOKEN}`, body: { role: 'consumer' } }]);
    assert.deepEqual(peer.state.opens, [{ type: 'avi-remote-open', version: 2, path: '/rpc' }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(closed, null, 'relay stayed open across a heartbeat tick');
    relay.close();
    assert.equal(closed.code, 1000);
    console.log('(pass) RelaySocket completes the keyless v2 handshake over a real socket and heartbeats');
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
      assert.deepEqual(peer.state.opens, [{ type: 'avi-remote-open', version: 2, path: '/rpc' }]);
      assert.ok(peer.state.requests.includes('rpc:discover'));
    } finally { await flush(); client.close(); }
    await flush();
    console.log('(pass) RpcClient opens relay sessions and completes RPC over the real socket');
  } finally { peer.stop(); }
}

try {
  await testRelaySocketHandshake();
  await testRpcClientOverRelay();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
