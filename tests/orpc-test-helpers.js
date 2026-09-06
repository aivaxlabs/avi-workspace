import { ORPC_PROTOCOL, parseFrame, requestFrame, responseFrames } from '../src/rpc/orpc.js';

export { ORPC_PROTOCOL };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Bytes(value) {
  return textEncoder.encode(typeof value === 'string' ? value : JSON.stringify(value));
}

export function encodeRequestFrame(id, method, content) {
  return requestFrame(id, method, content instanceof Uint8Array ? content : utf8Bytes(content));
}

export function encodeResponseFrame(id, content, execution = crypto.randomUUID()) {
  const [frame] = responseFrames(id, execution, content instanceof Uint8Array ? content : utf8Bytes(content));
  return frame;
}

export function eventFrame(method, params, { eventId = crypto.randomUUID(), expiresAt = Date.now() + 60_000, id = crypto.randomUUID() } = {}) {
  return encodeRequestFrame(id, String(method).replace(':', '.'), { eventId, expiresAt, params });
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
    const frame = decodeWireFrame(value);
    if (frame.type === 'REQ') {
      this.sent.push(frame);
      const fixture = { ...frame, method: frame.method.replace('.', ':') };
      queueMicrotask(() => this.respond?.(this, fixture));
    }
  }

  message(document) {
    let data = document;
    if (!(document instanceof Blob) && !ArrayBuffer.isView(document) && !(document instanceof ArrayBuffer)) {
      if (document?.type) data = JSON.stringify(document);
      else if (document?.id != null) data = encodeResponseFrame(document.id, document.error !== undefined ? { error: document.error } : { result: document.result ?? null });
      else if (document?.method) data = eventFrame(document.method, document.params ?? {});
    }
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = new Event('close');
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}
