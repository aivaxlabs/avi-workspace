import {
  ORPC_PROTOCOL,
  controlFrame,
  parseFrame,
  requestFrame,
  requestFrames,
  responseFrames,
} from '../src/rpc/orpc.js';

export { ORPC_PROTOCOL };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function newId() {
  return crypto.randomUUID().replaceAll('-', '');
}

export function utf8Bytes(value) {
  return textEncoder.encode(typeof value === 'string' ? value : JSON.stringify(value));
}

export async function sha256Check(content) {
  const bytes = content instanceof Uint8Array ? content : utf8Bytes(content);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return textEncoder.encode(`sha256:${hex}`);
}

export function encodeRequestFrame(id, method, content) {
  return requestFrame(id, method, content instanceof Uint8Array ? content : utf8Bytes(content));
}

export async function responseTransfer(id, content) {
  const bytes = content instanceof Uint8Array ? content : utf8Bytes(content);
  return [...responseFrames(id, bytes), controlFrame('RES', `${id}#CHECKSEND`, await sha256Check(bytes))];
}

export async function requestTransfer(id, method, content) {
  const bytes = content instanceof Uint8Array ? content : utf8Bytes(content);
  return [...requestFrames(id, method, bytes), controlFrame('REQ', `${id}#CHECKSEND`, await sha256Check(bytes))];
}

export async function eventFrame(method, params, { eventId = newId(), expiresAt = Date.now() + 60_000, id = newId() } = {}) {
  return requestTransfer(id, String(method).replace(':', '.'), { eventId, expiresAt, params });
}

export function decodeWireFrame(bytes) {
  const frame = parseFrame(bytes);
  const text = textDecoder.decode(frame.content);
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { ...frame, text, json };
}

export function decodeWireRequest(bytes) {
  const frame = decodeWireFrame(bytes);
  if (frame.type !== 'REQ') throw new Error('Expected an ORPC REQ frame.');
  return frame;
}

export async function until(condition, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for a test condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function reassemble(parts, final) {
  let bytes = 0;
  for (let part = 1; part <= final; part++) bytes += parts.get(part).content.length;
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (let part = 1; part <= final; part++) {
    result.set(parts.get(part).content, offset);
    offset += parts.get(part).content.length;
  }
  return result;
}

export class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances = [];

  constructor(url, protocols, { autoOpen = true } = {}) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.protocol = protocols?.[0] ?? ORPC_PROTOCOL;
    this.bufferedAmount = 0;
    this.readyState = 0;
    this.rawSent = [];
    this.sent = [];
    this.transfers = new Map();
    FakeSocket.instances.push(this);
    if (autoOpen) queueMicrotask(() => this.open());
  }

  open(protocol) {
    if (this.readyState === 3) return;
    if (protocol) this.protocol = protocol;
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  send(value) {
    if (typeof value === 'string') {
      this.onControl?.(JSON.parse(value));
      return;
    }
    this.rawSent.push(value);
    const frame = parseFrame(value);
    if (frame.control) {
      this.receiveControl(frame);
      return;
    }
    if (frame.type !== 'REQ' || frame.baseId === undefined) return;
    let transfer = this.transfers.get(frame.baseId);
    if (!transfer) {
      transfer = { method: frame.method, parts: new Map(), final: null, body: null, responded: false };
      this.transfers.set(frame.baseId, transfer);
    }
    if (transfer.method !== frame.method || transfer.body) return;
    transfer.parts.set(frame.part, frame);
    if (frame.final) transfer.final = frame.part;
    if (transfer.final !== null && transfer.parts.size === transfer.final) {
      transfer.body = reassemble(transfer.parts, transfer.final);
    }
  }

  async receiveControl(frame) {
    const { type, baseId, control } = frame;
    const reply = type === 'REQ' ? 'RES' : 'REQ';
    if (!baseId) {
      if (control === 'PING') this.deliver(controlFrame('RES', '#PONG'));
      else if (control === 'EXIT') this.deliver(controlFrame('RES', '#BYE'));
      return;
    }
    if (control === 'CHECKSEND' && type === 'REQ') {
      const transfer = this.transfers.get(baseId);
      if (!transfer?.body || transfer.responded) {
        this.deliver(controlFrame('RES', `${baseId}#CHECKFAIL`));
        return;
      }
      transfer.responded = true;
      const expected = textDecoder.decode(await sha256Check(transfer.body));
      const hashes = textDecoder.decode(frame.content).split(';');
      if (!hashes.length || !hashes.every((hash) => hash === expected)) {
        this.deliver(controlFrame('RES', `${baseId}#CHECKFAIL`));
        return;
      }
      const text = textDecoder.decode(transfer.body);
      let json;
      try { json = JSON.parse(text); } catch { json = undefined; }
      const fixture = { type: 'REQ', id: baseId, baseId, method: transfer.method.replace('.', ':'), part: 1, final: true, content: transfer.body, text, json };
      this.sent.push(fixture);
      queueMicrotask(() => {
        try {
          const answered = this.respond?.(this, fixture);
          if (answered instanceof Promise) answered.catch(() => {});
        } catch {}
      });
    } else if (control === 'CHECKSEND' && type === 'RES') {
      this.deliver(controlFrame('REQ', `${baseId}#CHECKOK`));
    } else if (control === 'CANCEL' && type === 'REQ') {
      this.transfers.delete(baseId);
      this.deliver(controlFrame('RES', `${baseId}#CANCELACK`));
    }
  }

  deliver(frame) {
    this.dispatchEvent(new MessageEvent('message', { data: frame }));
  }

  message(document) {
    if (document instanceof Promise) {
      document.then((resolved) => this.message(resolved));
      return;
    }
    if (Array.isArray(document)) {
      for (const frame of document) this.deliver(frame);
      return;
    }
    if (document instanceof Blob || ArrayBuffer.isView(document) || document instanceof ArrayBuffer) {
      this.deliver(document);
      return;
    }
    if (typeof document === 'string') {
      this.deliver(textEncoder.encode(document));
      return;
    }
    if (document?.type) {
      this.deliver(JSON.stringify(document));
      return;
    }
    if (document?.id != null) {
      const content = document.error !== undefined ? { error: document.error } : { result: document.result ?? null };
      responseTransfer(document.id, content).then((frames) => this.message(frames));
      return;
    }
    if (document?.method) {
      const { method, params = {}, eventId = newId(), expiresAt = Date.now() + 60_000 } = document;
      this.message(eventFrame(method, params, { eventId, expiresAt }));
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = new Event('close');
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}
