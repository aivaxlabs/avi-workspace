import { AIVAX_RELAYS_URL } from './aivax.js';
import { RPC_PROTOCOL } from './contracts.js';

export class RelaySocket extends EventTarget {
  static OPEN = 1;

  constructor({ deviceId, accessToken, path = '/rpc', WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, timeoutMs = 10_000, heartbeatMs = 30_000, heartbeatTimeoutMs = 60_000 }) {
    super();
    this.readyState = 0;
    this.protocol = '';
    this.controller = new AbortController();
    this.socket = null;
    this.timer = setTimeout(() => this.finish(1006, 'Relay connection timed out.', true), timeoutMs);
    this.heartbeat = null;
    this.lastPong = Date.now();
    this.pingId = null;
    this.windowStart = Date.now();
    this.windowBytes = 0;
    this.windowMessages = 0;
    this.stalledSince = null;
    queueMicrotask(async () => {
      try {
        const streamId = typeof path === 'string' && path.startsWith('/rpc/conversations/streams/') ? decodeURIComponent(path.slice('/rpc/conversations/streams/'.length)) : null;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId) || !accessToken
          || typeof path !== 'string' || path.length > 2048
          || !(path === '/rpc' || streamId && streamId !== '.' && streamId !== '..' && !/[\/\\?#\u0000]/.test(streamId) && !/[?#]/.test(path))) {
          this.finish(1008, 'Invalid relay connection settings.', false);
          return;
        }
        if (this.readyState === 3) return;
        const response = await fetchImpl(`${AIVAX_RELAYS_URL}/${deviceId}/tickets`, {
          method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: this.controller.signal,
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'consumer' }),
        });
        if (this.readyState === 3) return;
        if (response.status !== 201) {
          const unauthorized = response.status === 401 || response.status === 403;
          this.finish(unauthorized ? 4003 : 1013, unauthorized ? 'AIVAX authorization expired or was rejected. Log in again.' : 'Could not acquire a relay ticket.', response.status === 409 || response.status === 429 || response.status >= 500);
          return;
        }
        const ticket = await response.json();
        if (this.readyState === 3) return;
        let url;
        try { url = new URL(ticket?.websocketUrl); }
        catch { this.finish(1008, 'Invalid relay ticket response.', false); return; }
        if (ticket.protocol !== 'avi-relay-v1' || typeof ticket.ticket !== 'string' || !/^[a-f0-9]{64}$/i.test(ticket.ticket)
          || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= Date.now()
          || url.protocol !== 'wss:' || url.host !== new URL(AIVAX_RELAYS_URL).host
          || url.username || url.password || url.search || url.hash
          || !new RegExp(`^/v1/relays/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/${deviceId}/connect$`, 'i').test(url.pathname)) {
          this.finish(1008, 'Invalid relay ticket response.', false);
          return;
        }
        const socket = new WebSocketImpl(url.toString(), ['avi-relay-v1', `avi-relay-ticket.${ticket.ticket}`]);
        this.socket = socket;
        socket.addEventListener('open', () => {
          if (this.readyState === 3) return;
          if (socket.protocol !== 'avi-relay-v1') { this.finish(1008, 'Unsupported relay protocol.', false); return; }
          try { socket.send(JSON.stringify({ type: 'avi-remote-open', version: 2, path })); }
          catch { this.finish(1006, 'Remote handshake failed.', true); }
        });
        socket.addEventListener('message', (event) => {
          if (this.readyState === 3) return;
          let frame;
          try { frame = typeof event.data === 'string' ? JSON.parse(event.data) : null; } catch { frame = null; }
          if (frame?.type === 'avi-remote-error') {
            const retryable = frame.version === 2 && frame.code === 'unavailable';
            this.finish(retryable ? 1013 : 4003, frame.code === 'unauthorized' ? 'The remote Avi rejected this AIVAX account.' : 'Avi Remote handshake failed.', retryable);
            return;
          }
          if (this.readyState === 0) {
            if (frame?.type !== 'avi-remote-ready' || frame.version !== 2) { this.finish(1008, 'Invalid Remote handshake response.', false); return; }
            clearTimeout(this.timer);
            this.protocol = RPC_PROTOCOL;
            this.readyState = 1;
            this.lastPong = Date.now();
            this.heartbeat = setInterval(() => {
              if (Date.now() - this.lastPong >= heartbeatTimeoutMs) { this.finish(1006, 'Relay heartbeat timed out.', true); return; }
              if (socket.bufferedAmount > 0) {
                this.stalledSince ??= Date.now();
                if (Date.now() - this.stalledSince >= heartbeatTimeoutMs) { this.finish(1006, 'Relay output stalled.', true); return; }
              } else this.stalledSince = null;
              if (!this.pingId) {
                this.pingId = crypto.randomUUID();
                try { this.send(JSON.stringify({ type: 'avi-remote-ping', version: 2, id: this.pingId })); } catch {}
              }
            }, heartbeatMs);
            this.dispatchEvent(new Event('open'));
            return;
          }
          if (frame?.type === 'avi-remote-pong') {
            if (frame.version !== 2 || !this.pingId || frame.id !== this.pingId) { this.finish(1008, 'Invalid relay heartbeat.', false); return; }
            this.lastPong = Date.now();
            this.pingId = null;
            return;
          }
          const size = typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data?.size ?? event.data?.byteLength;
          if (!Number.isFinite(size) || size > 1024 * 1024) { this.finish(1009, 'Relay payload limit exceeded.', false); return; }
          const forwarded = new Event('message');
          forwarded.data = event.data;
          this.dispatchEvent(forwarded);
        });
        socket.addEventListener('close', (event) => this.finish(event.code, `Relay connection closed (${event.code}).`, [1006, 1011, 1012, 1013, 4001].includes(event.code)));
        socket.addEventListener('error', () => this.finish(1006, 'Relay connection failed.', true));
      } catch (error) {
        if (this.readyState !== 3) this.finish(error instanceof SyntaxError || error instanceof URIError ? 1008 : 1006, 'Could not establish the relay connection.', !(error instanceof SyntaxError || error instanceof URIError));
      }
    });
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('Remote RPC is not ready.');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data?.byteLength ?? data?.size;
    if (Date.now() - this.windowStart >= 1000) { this.windowStart = Date.now(); this.windowBytes = 0; this.windowMessages = 0; }
    if (!Number.isFinite(bytes) || bytes > 1024 * 1024 || this.socket.bufferedAmount + bytes > 4 * 1024 * 1024
      || this.windowMessages >= 128 || this.windowBytes + bytes > 4 * 1024 * 1024) {
      this.finish(1008, 'Relay traffic limit exceeded. Reduce request volume before reconnecting.', false);
      throw new Error('Relay traffic limit exceeded.');
    }
    this.windowMessages += 1;
    this.windowBytes += bytes;
    try { this.socket.send(data); }
    catch { this.finish(1006, 'Relay send failed; request outcome is unknown.', true); throw new Error('Relay send failed; request outcome is unknown.'); }
  }

  finish(code, reason, retryable) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.controller.abort();
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(1000, 'Channel closed'); } catch {}
    const event = new Event('close');
    Object.assign(event, { code, reason, retryable });
    this.dispatchEvent(event);
  }

  close() {
    this.finish(1000, 'Client closed', false);
  }
}
