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

const RESUME_PROBE_MS = 5_000;

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
    this.peer = this.createPeer();
    this.closed = false;
    this.disposed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.problemTimer = null;
    this.failures = 0;
    this.probe = null;
    this.status = { status: 'offline', error: null, problem: false };
  }

  createPeer() {
    return new OrpcPeer({
      integrity: true,
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
      onClose: () => {
        this.socket?.close(1000, 'ORPC shutdown', !this.closed);
      },
      onRequest: (method, bytes) => {
        if (this.closed) return new Uint8Array();
        const content = utf8Text(bytes);
        const event = JSON.parse(content);
        if (!event.eventId || !Number.isFinite(event.expiresAt)) throw new OrpcError('Invalid event');
        // A suspended tab (iOS background) receives events whose deadline already passed; dropping
        // them is safe because the conversation sequence gap triggers an authoritative recovery.
        if (event.expiresAt < Date.now()) {
          this.dispatchEvent(new CustomEvent('stale-event', { detail: { method: method.replace('.', ':') } }));
          return new TextEncoder().encode('OK');
        }
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
  }

  connect() {
    if (!this.WebSocketImpl) return Promise.reject(new Error('WebSocket is unavailable in this browser.'));
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return Promise.resolve(this);
    if (this.connectPromise) return this.connectPromise;
    this.closed = false;
    this.disposed = false;
    if (this.peer.closed) this.peer = this.createPeer();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dispatchStatus('checking');
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = this.relay
        ? new RelaySocket({ ...this.relay, path: this.path, WebSocketImpl: this.WebSocketImpl })
        : new this.WebSocketImpl(this.url, this.protocols);
      this.socket = socket;
      let opened = false;
      const openingTimer = setTimeout(() => {
        rejectInitial(new Error('Connection attempt timed out.'));
        socket.close(1000, 'Connection attempt timed out', true);
      }, 15_000);
      const cleanupInitial = () => {
        clearTimeout(openingTimer);
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
        clearTimeout(this.problemTimer);
        this.problemTimer = null;
        this.stableTimer = setTimeout(() => {
          if (this.socket === socket) { this.reconnectAttempt = 0; this.failures = 0; }
        }, 30_000);
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

  // Returning from the background (iOS suspends sockets without a close event) can leave an OPEN
  // socket that no longer delivers frames; a bounded ping proves liveness or drops it immediately.
  resume() {
    if (this.closed || this.disposed) return Promise.resolve(this);
    if (this.socket?.readyState !== this.WebSocketImpl?.OPEN) {
      this.reconnectAttempt = 0;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      return this.connectUntilReady();
    }
    if (this.probe) return this.probe;
    const socket = this.socket;
    this.probe = this.peer.ping(RESUME_PROBE_MS).then(() => this, () => {
      if (this.closed || this.disposed) return this;
      if (this.socket === socket && socket.readyState === this.WebSocketImpl.OPEN) {
        const reason = 'Connection stalled after resume';
        this.handleClose({ code: 1006, reason, retryable: true }, socket);
        this.socket = null;
        try { socket.close(1000, reason); } catch {}
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
      }
      return this.connectUntilReady();
    }).finally(() => { this.probe = null; });
    return this.probe;
  }

  connectUntilReady({ timeoutMs = 0 } = {}) {
    if (!this.WebSocketImpl) return Promise.reject(new Error('WebSocket is unavailable in this browser.'));
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.removeEventListener('status', status);
        reject(new OrpcError('Connection is still recovering', 'INCOMPLETE'));
      }, timeoutMs) : null;
      const status = () => {
        if (this.status.status !== 'online' && !this.closed) return;
        clearTimeout(timer);
        this.removeEventListener('status', status);
        if (this.closed) reject(new OrpcError(this.status.error || 'Connection closed', 'CANCELLED'));
        else resolve(this);
      };
      this.addEventListener('status', status);
      this.connect().catch((error) => {
        if (!this.closed && this.reconnect) {
          this.scheduleReconnect();
          return;
        }
        clearTimeout(timer);
        this.removeEventListener('status', status);
        reject(error);
      });
    });
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
    if (this.socket !== source || source?.readyState !== this.WebSocketImpl.OPEN || (this.closed && !this.peer.closing)) return;
    this.metrics.receivedBytes += value?.byteLength ?? 0;
    this.peer.receive(value);
  }

  handleClose(event, source = this.socket) {
    if (this.socket !== source || this.disposed) return;
    clearTimeout(this.stableTimer);
    this.failures++;
    if ([1002, 1008, 1009, 4003].includes(event.code) || event.retryable === false) {
      // Only an authentication rejection needs the user; protocol or limit rejections restart
      // from a fresh peer after a longer backoff so the session heals without intervention.
      if (event.code === 4003) this.closed = true;
      else this.reconnectAttempt = Math.max(this.reconnectAttempt, 3);
      this.peer.terminate(new OrpcError(event.reason || 'Channel rejected', event.code === 1009 ? 'LIMIT' : 'PROTOCOL'));
    } else this.peer.channelFailed();
    this.dispatchStatus('offline', event.reason || `Connection closed (${event.code}).`);
    if (!this.problemTimer && event.reason !== 'Client closed' && event.reason !== 'ORPC shutdown') this.problemTimer = setTimeout(() => {
      this.problemTimer = null;
      if (this.status.status !== 'online') this.dispatchStatus(this.status.status, this.status.error, true);
    }, 15_000);
    this.dispatchEvent(new CustomEvent('close', { detail: event }));
    if (!this.closed && this.reconnect) this.scheduleReconnect();
  }

  scheduleReconnect(delayMs = null) {
    if (this.closed || this.reconnectTimer) return;
    const delay = delayMs ?? (this.relay
      ? Math.min(1_000 * (2 ** Math.min(this.reconnectAttempt++, 5)), 30_000) * (0.75 + Math.random() * 0.25)
      : Math.min(1_000 * (2 ** Math.min(this.reconnectAttempt++, 4)), 15_000));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  dispatchStatus(status, error = null, problem = this.status.problem || this.failures >= 3) {
    this.status = { status, error, problem: status !== 'online' && problem };
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  close() {
    this.disposed = true;
    this.closed = true;
    clearTimeout(this.stableTimer);
    clearTimeout(this.problemTimer);
    this.problemTimer = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.events.clear();
    this.dispatchStatus('offline', 'Connection closed', false);
    const socket = this.socket;
    if (socket?.readyState === this.WebSocketImpl.OPEN) {
      return this.peer.shutdown().catch((error) => {
        this.dispatchEvent(new CustomEvent('protocol-error', { detail: error }));
      });
    }
    this.peer.terminate();
    socket?.close(1000, 'Client closed');
    this.socket = null;
  }
}
