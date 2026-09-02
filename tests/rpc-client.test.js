import { describe, expect, test } from 'bun:test';
import { RpcClient, RpcError } from '../src/rpc/client.js';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.protocol = 'avi-rpc-v1';
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  open(protocol = 'avi-rpc-v1') { this.protocol = protocol; this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(value) { this.sent.push(value); }
  message(value) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
  close(code = 1000, reason = '') { this.readyState = 3; const event = new Event('close'); Object.assign(event, { code, reason }); this.dispatchEvent(event); }
}

describe('RpcClient', () => {
  test('connects only when the server selects avi-rpc-v1', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    FakeSocket.instances.at(-1).open();
    await expect(connecting).resolves.toBe(client);
    client.close();

    const rejected = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const rejectedConnect = rejected.connect();
    FakeSocket.instances.at(-1).open('other-protocol');
    await expect(rejectedConnect).rejects.toThrow('unsupported WebSocket protocol');
  });

  test('rejects deterministically when closed before open', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    FakeSocket.instances.at(-1).close(1006, 'refused');
    await expect(connecting).rejects.toThrow('refused');
    expect(client.connectPromise).toBeNull();
  });

  test('correlates results and errors and emits notifications', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    const socket = FakeSocket.instances.at(-1);
    socket.open();
    await connecting;
    const notifications = [];
    client.addEventListener('notification', (event) => notifications.push(event.detail));
    const success = client.request('rpc:discover', { compact: true });
    const request = JSON.parse(socket.sent.at(-1));
    socket.message(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { apiVersion: 1 } }));
    await expect(success).resolves.toEqual({ apiVersion: 1 });
    socket.message(new Blob([JSON.stringify({ jsonrpc: '2.0', method: 'conversation:event', params: { sequence: 1 } })]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toEqual([{ method: 'conversation:event', params: { sequence: 1 } }]);
    const failure = client.request('bad');
    const badRequest = JSON.parse(socket.sent.at(-1));
    socket.message(JSON.stringify({ jsonrpc: '2.0', id: badRequest.id, error: { code: -32601, message: 'Method not found' } }));
    await expect(failure).rejects.toBeInstanceOf(RpcError);
    client.close();
  });

  test('processes asynchronously decoded frames in arrival order', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    const socket = FakeSocket.instances.at(-1);
    socket.open();
    await connecting;
    const notifications = [];
    client.addEventListener('notification', (event) => notifications.push(event.detail.params.sequence));
    let release;
    const delayed = new Blob([JSON.stringify({ jsonrpc: '2.0', method: 'conversation:event', params: { sequence: 1 } })]);
    delayed.text = async () => {
      await new Promise((resolve) => { release = resolve; });
      return JSON.stringify({ jsonrpc: '2.0', method: 'conversation:event', params: { sequence: 1 } });
    };
    socket.message(delayed);
    socket.message(JSON.stringify({ jsonrpc: '2.0', method: 'conversation:event', params: { sequence: 2 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toEqual([]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toEqual([1, 2]);
    client.close();
  });

  test('drops a frame that finishes decoding after the socket is closed', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    const socket = FakeSocket.instances.at(-1);
    socket.open();
    await connecting;
    const notifications = [];
    client.addEventListener('notification', (event) => notifications.push(event.detail));
    let release;
    const delayed = new Blob(['']);
    delayed.text = async () => {
      await new Promise((resolve) => { release = resolve; });
      return JSON.stringify({ jsonrpc: '2.0', method: 'conversation:event', params: { sequence: 1 } });
    };
    socket.message(delayed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toEqual([]);
  });

  test('continues after a malformed JSON-RPC document', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    const socket = FakeSocket.instances.at(-1);
    socket.open();
    await connecting;
    const errors = [];
    const notifications = [];
    client.addEventListener('protocol-error', (event) => errors.push(event.detail.message));
    client.addEventListener('notification', (event) => notifications.push(event.detail.params.sequence));
    socket.message('null');
    socket.message(JSON.stringify({ jsonrpc: '2.0', method: 'conversation:event', params: { sequence: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(['RPC server returned an invalid JSON-RPC document.']);
    expect(notifications).toEqual([1]);
    client.close();
  });

  test('ignores a delayed close from a replaced socket', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', reconnect: false, WebSocketImpl: FakeSocket });
    const firstConnect = client.connect();
    const firstSocket = FakeSocket.instances.at(-1);
    firstSocket.open();
    await firstConnect;
    firstSocket.readyState = 3;
    const secondConnect = client.connect();
    const secondSocket = FakeSocket.instances.at(-1);
    secondSocket.open();
    await secondConnect;
    const pending = client.request('still-active');
    const request = JSON.parse(secondSocket.sent.at(-1));
    firstSocket.close(1006, 'late close');
    secondSocket.message(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ok' }));
    await expect(pending).resolves.toBe('ok');
    client.close();
  });

  test('times out pending requests', async () => {
    const client = new RpcClient({ url: 'ws://test/rpc', apiKey: 'key', timeoutMs: 5, reconnect: false, WebSocketImpl: FakeSocket });
    const connecting = client.connect();
    FakeSocket.instances.at(-1).open();
    await connecting;
    await expect(client.request('slow')).rejects.toThrow('timed out');
    client.close();
  });
});
