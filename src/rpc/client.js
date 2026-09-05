import { RPC_PROTOCOL } from './contracts.js';
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
  constructor({ url, apiKey, relay = null, path = '/rpc', timeoutMs = 15_000, reconnect = true, WebSocketImpl = globalThis.WebSocket }) {
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
    this.pending = new Map();
    this.nextId = 1;
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

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return Promise.reject(new Error('RPC socket is not connected.'));
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out after ${timeoutMs}ms: ${method}${this.relay ? '; request outcome is unknown. Do not resend without checking remote state.' : ''}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify(message)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params) {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) throw new Error('RPC socket is not connected.');
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  async handleMessage(raw, source = this.socket) {
    let documents;
    try {
      const text = typeof raw === 'string'
        ? raw
        : raw instanceof Blob
          ? await raw.text()
          : new TextDecoder().decode(raw instanceof ArrayBuffer ? raw : raw.buffer);
      if (this.socket !== source || source?.readyState !== this.WebSocketImpl.OPEN || this.closed) return;
      const parsed = JSON.parse(text);
      documents = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      this.dispatchEvent(new CustomEvent('protocol-error', { detail: new Error('RPC server returned invalid JSON.') }));
      return;
    }
    for (const document of documents) {
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        this.dispatchEvent(new CustomEvent('protocol-error', { detail: new Error('RPC server returned an invalid JSON-RPC document.') }));
        continue;
      }
      if (Object.hasOwn(document, 'id')) {
        const pending = this.pending.get(document.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(document.id);
        if (document.error) pending.reject(new RpcError(document.error.message, document.error.code, document.error.data));
        else pending.resolve(document.result);
      } else if (document.method) {
        this.dispatchEvent(new CustomEvent('notification', { detail: { method: document.method, params: document.params } }));
      }
    }
  }

  handleClose(event, source = this.socket) {
    if (this.socket !== source) return;
    clearTimeout(this.stableTimer);
    if (this.relay && event.retryable === false) this.closed = true;
    this.rejectPending(new Error('RPC connection closed before the request completed; request outcome is unknown. Commands are not automatically resent.'));
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

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    clearTimeout(this.stableTimer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectPending(new Error('RPC client was closed.'));
    this.socket?.close(1000, 'Client closed');
    this.socket = null;
  }
}
