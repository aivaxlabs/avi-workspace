import { describe, expect, test } from 'bun:test';
import { buildMessageTimeline, formatWorkedDuration, operationGroupHasTools, operationGroupLabel, partitionMessageTimeline } from '../src/lib/message-timeline.js';

describe('assistant message timeline', () => {
  test('uses canonical content segments without duplicating aggregate message content', () => {
    const timeline = buildMessageTimeline({
      content: 'Reasoning accidentally concatenated with the final answer.',
      segments: [
        { id: 'r1', type: 'reasoning', text: 'Inspect the request.' },
        { id: 'c1', type: 'content', text: 'Final answer.' },
      ],
    });

    expect(timeline).toEqual([
      { type: 'operations', items: [{ id: 'r1', type: 'reasoning', text: 'Inspect the request.' }] },
      { type: 'content', text: 'Final answer.' },
    ]);
  });

  test('preserves interleaved tool groups and assistant content', () => {
    const timeline = buildMessageTimeline({
      content: 'Legacy aggregate must not replace the canonical sequence.',
      segments: [
        { id: 't1', type: 'tool-call', name: 'read_file', resultText: 'one' },
        { id: 't2', type: 'tool-call', name: 'memory_search' },
        { id: 'c1', type: 'content', text: 'First finding.' },
        { id: 't3', type: 'tool-call', name: 'run_in_terminal', resultText: 'done' },
        { id: 'c2', type: 'content', text: 'Final answer.' },
      ],
    });

    expect(timeline.map((item) => item.type)).toEqual(['operations', 'content', 'operations', 'content']);
    expect(timeline[0].items.map((item) => item.name)).toEqual(['read_file', 'memory_search']);
    expect(timeline[0].items[1].resultText).toBeUndefined();
    expect(timeline[2].items[0].resultText).toBe('done');
  });

  test('keeps prior operations under Worked for when a final answer follows', () => {
    const timeline = buildMessageTimeline({
      segments: [
        { type: 'reasoning', text: 'Plan.' },
        { type: 'tool-call', name: 'read_file', resultText: 'done' },
        { type: 'content', text: 'Answer.' },
      ],
    });

    const partition = partitionMessageTimeline(timeline);
    expect(partition.workedItems).toHaveLength(1);
    expect(partition.finalItems).toEqual([{ type: 'content', text: 'Answer.' }]);
  });

  test('retains aggregate content for legacy messages without canonical content segments', () => {
    expect(buildMessageTimeline({ content: 'Legacy answer.', segments: [] })).toEqual([
      { type: 'content', text: 'Legacy answer.' },
    ]);
  });

  test('labels error-only operational groups as details', () => {
    const errors = [{ type: 'error', message: 'Tool failed.' }];
    expect(operationGroupLabel(errors)).toBe('Details');
    expect(operationGroupHasTools(errors)).toBeFalse();
    expect(operationGroupHasTools([{ type: 'tool-call', name: 'read_file' }])).toBeTrue();
  });

  test('formats Desktop-style worked duration labels', () => {
    expect(formatWorkedDuration('2026-09-01T10:00:00.000Z', '2026-09-01T10:00:14.000Z')).toBe('Worked for 14 seconds');
    expect(formatWorkedDuration('2026-09-01T10:00:00.000Z', '2026-09-01T10:01:05.000Z')).toBe('Worked for 1m 5s');
  });
});
