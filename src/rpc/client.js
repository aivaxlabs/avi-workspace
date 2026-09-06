import { RPC_PROTOCOL } from './contracts.js';
import { OrpcPeer, OrpcError, utf8Text } from './orpc.js';
import { createAuthProtocols } from './url.js';
import { RelaySocket } from './relay-socket.js';

export class RpcError extends Error {
  constructor(message, code, data) {
    super(data?.message || message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export class RpcClient extends EventTarget {
  constructor({ url, apiKey, relay = null, path = '/rpc', timeoutMs = 60_000, reconnect = true, WebSocketImpl = globalThis.WebSocket }) {
    super();
    this.url = url;
    this.relay = relay;
    this.apiKey = apiKey;
    this.path = path;
    this.stableTimer = null;
    this.protocols = this.relay ? null : createAuthProtocols(apiKey);
    this.timeoutMs = timeoutMs;
    this.reconnect = reconnect;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.events = new Map();
    this.metrics = { sentBytes: 0, receivedBytes: 0, completed: 0, failed: 0, cancelled: 0, latencyMs: null, latencyMinMs: null, latencyMaxMs: null, latencyTotalMs: 0, lastResponseAt: null, connectedAt: null, reconnects: 0 };
    this.peer = new OrpcPeer({
      send: (frame) => {
        this.socket.send(frame);
        this.metrics.sentBytes += frame.byteLength;
      },
      isOpen: () => this.socket?.readyState === this.WebSocketImpl.OPEN,
      bufferedAmount: () => this.socket?.bufferedAmount ?? 0,
      onError: (error) => {
        this.dispatchEvent(new CustomEvent('protocol-error', { detail: error }));
        this.socket?.close(error.code === 'LIMIT' ? 1009 : 1002, error.code);
      },
      onRequest: (method, bytes) => {
        const content = utf8Text(bytes);
        const event = JSON.parse(content);
        if (!event.eventId || !Number.isFinite(event.expiresAt) || event.expiresAt < Date.now()) throw new OrpcError('Invalid or expired event');
        for (const [id, entry] of this.events) if (entry.expiresAt < Date.now()) this.events.delete(id);
        const previous = this.events.get(event.eventId);
        if (previous) {
          if (previous.content !== content || previous.method !== method) throw new OrpcError('Conflicting event identifier');
          return new TextEncoder().encode('OK');
        }
        if (this.events.size >= 4096) throw new OrpcError('Event acceptance limit exceeded', 'LIMIT');
        this.dispatchEvent(new CustomEvent('notification', { detail: { method: method.replace('.', ':'), params: event.params } }));
        this.events.set(event.eventId, { content, method, expiresAt: event.expiresAt });
        return new TextEncoder().encode('OK');
      },
    });
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  connect() {
    if (!this.WebSocketImpl) return Promise.reject(new Error('WebSocket is unavailable in this browser.'));
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return Promise.resolve(this);
    if (this.connectPromise) return this.connectPromise;
    this.closed = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dispatchStatus('checking');
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = this.relay
        ? new RelaySocket({ ...this.relay, path: this.path, WebSocketImpl: this.WebSocketImpl })
        : new this.WebSocketImpl(this.url, this.protocols);
      this.socket = socket;
      let opened = false;
      const cleanupInitial = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onInitialError);
        socket.removeEventListener('close', onInitialClose);
      };
      const rejectInitial = (error) => {
        if (opened) return;
        cleanupInitial();
        reject(error);
      };
      const onOpen = () => {
        if (socket.protocol !== RPC_PROTOCOL) {
          rejectInitial(new Error(`Server selected unsupported WebSocket protocol ${socket.protocol || 'none'}.`));
          this.closed = true;
          socket.close(1002, 'Unsupported subprotocol');
          return;
        }
        opened = true;
        if (this.metrics.connectedAt !== null) this.metrics.reconnects++;
        this.metrics.connectedAt = Date.now();
        cleanupInitial();
        if (this.relay) this.stableTimer = setTimeout(() => { if (this.socket === socket) this.reconnectAttempt = 0; }, 30_000);
        else this.reconnectAttempt = 0;
        this.dispatchStatus('online');
        this.dispatchEvent(new CustomEvent('open'));
        resolve(this);
      };
      const onInitialError = () => rejectInitial(new Error('Could not connect to the Avi RPC endpoint.'));
      const onInitialClose = (event) => rejectInitial(new Error(event.reason || `RPC socket closed before opening (${event.code}).`));
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onInitialError);
      socket.addEventListener('close', onInitialClose);
      let messageQueue = Promise.resolve();
      socket.addEventListener('message', (event) => {
        messageQueue = messageQueue
          .then(() => this.handleMessage(event.data, socket))
          .catch((error) => this.dispatchEvent(new CustomEvent('protocol-error', { detail: error })));
      });
      socket.addEventListener('close', (event) => this.handleClose(event, socket));
      socket.addEventListener('error', () => this.dispatchEvent(new CustomEvent('transport-error')));
    }).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async request(method, params, { timeoutMs = this.timeoutMs, signal } = {}) {
    const content = JSON.stringify({ operationId: crypto.randomUUID(), expiresAt: Date.now() + 180_000, params });
    const startedAt = performance.now();
    let response;
    try {
      const bytes = await this.peer.call(method.replace(':', '.'), new TextEncoder().encode(content), { attemptMs: timeoutMs, signal });
      this.metrics.completed++;
      this.metrics.latencyMs = performance.now() - startedAt;
      this.metrics.latencyMinMs = Math.min(this.metrics.latencyMinMs ?? Infinity, this.metrics.latencyMs);
      this.metrics.latencyMaxMs = Math.max(this.metrics.latencyMaxMs ?? 0, this.metrics.latencyMs);
      this.metrics.latencyTotalMs += this.metrics.latencyMs;
      this.metrics.lastResponseAt = Date.now();
      response = bytes;
    } catch (error) {
      if (error.code === 'CANCELLED') this.metrics.cancelled++;
      else this.metrics.failed++;
      throw error;
    }
    response = JSON.parse(utf8Text(response));
    if (response.error) throw new RpcError(response.error.message, response.error.code, response.error.data);
    return response.result;
  }

  notify(method, params) {
    return this.request(method, params);
  }

  async handleMessage(raw, source = this.socket) {
    const value = raw instanceof Blob ? await raw.arrayBuffer() : raw;
    if (this.socket !== source || source?.readyState !== this.WebSocketImpl.OPEN || this.closed) return;
    this.metrics.receivedBytes += value?.byteLength ?? 0;
    this.peer.receive(value);
  }

  handleClose(event, source = this.socket) {
    if (this.socket !== source) return;
    clearTimeout(this.stableTimer);
    if (this.relay && event.retryable === false) this.closed = true;
    if ([1002, 1008, 1009, 4003].includes(event.code) || event.retryable === false) {
      this.closed = true;
      this.peer.terminate(new OrpcError(event.reason || 'Channel rejected', event.code === 1009 ? 'LIMIT' : 'PROTOCOL'));
    } else this.peer.channelFailed();
    this.dispatchStatus('offline', event.reason || `Connection closed (${event.code}).`);
    this.dispatchEvent(new CustomEvent('close', { detail: event }));
    if (!this.closed && this.reconnect) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.relay
      ? Math.min(1_000 * (2 ** Math.min(this.reconnectAttempt++, 5)), 30_000) * (0.75 + Math.random() * 0.25)
      : Math.min(1_000 * (2 ** this.reconnectAttempt++), 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  dispatchStatus(status, error = null) {
    this.dispatchEvent(new CustomEvent('status', { detail: { status, error } }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.stableTimer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.peer.terminate();
    this.events.clear();
    this.socket?.close(1000, 'Client closed');
    this.socket = null;
  }
}
