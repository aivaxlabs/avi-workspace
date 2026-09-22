import { expect, test } from 'bun:test';
import { controlFrame, OrpcPeer, parseFrame, requestFrame, requestFrames } from '../src/rpc/orpc.js';

const bytes = (text) => new TextEncoder().encode(text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition) => {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    expect(Date.now()).toBeLessThan(deadline);
    await sleep(5);
  }
};
const recorder = (options = {}) => {
  const sent = [];
  const peer = new OrpcPeer({
    integrity: false,
    isOpen: () => true,
    send: (frame) => sent.push(parseFrame(frame)),
    limits: { attemptMs: 1000, overallMs: 3000, retries: 0 },
    ...options,
  });
  return { peer, sent };
};

test('ignores a byte-identical duplicate part after dispatch', async () => {
  let calls = 0;
  const { peer, sent } = recorder({ onRequest: () => { calls += 1; return new Promise(() => {}); } });
  try {
    const frames = [...requestFrames('a', 'm', bytes('body'))];
    for (const frame of frames) peer.receive(frame);
    await until(() => calls === 1);

    peer.receive(frames[0]);
    await sleep(20);

    expect(calls).toBe(1);
    expect(sent.some((frame) => frame.control === 'LOCKED')).toBe(false);
  } finally {
    peer.terminate();
  }
});

test('acknowledges repeated CHECKSEND without redispatching', async () => {
  let calls = 0;
  const { peer, sent } = recorder({
    integrity: true,
    onRequest: () => { calls += 1; return new Promise(() => {}); },
  });
  try {
    const body = bytes('abc');
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', body)).toString('hex');
    const check = bytes(`sha256:${hash}`);
    peer.receive(requestFrame('a', 'm', body));
    await until(() => peer.incoming.get('a')?.content);

    peer.receive(controlFrame('REQ', 'a#CHECKSEND', check));
    peer.receive(controlFrame('REQ', 'a#CHECKSEND', check));
    await until(() => calls === 1 && sent.filter((frame) => frame.control === 'CHECKOK').length === 2);

    expect(calls).toBe(1);
  } finally {
    peer.terminate();
  }
});
