import { describe, expect, test } from 'bun:test';
import { moveQueueId, steerQueuedParams } from '../src/lib/queue-actions.js';

describe('queue action helpers', () => {
  test('moves ids within bounds and rejects out-of-bounds moves', () => {
    expect(moveQueueId(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveQueueId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveQueueId(['a', 'b', 'c'], 2, 1)).toBeNull();
    expect(moveQueueId(['a'], 0, -1)).toBeNull();
  });

  test('builds steer promotion params from the queued list', () => {
    expect(steerQueuedParams([{ id: 'q1' }, { id: 'q2' }], 'q2')).toEqual({ queueType: 'queue', messageIds: ['q1', 'q2'], steerMessageId: 'q2' });
  });
});
