import { describe, expect, test } from 'bun:test';
import { buildMessageTimeline, formatWorkedDuration, groupAssistantTurns, operationGroupHasTools, operationGroupLabel, parseStructuredAgentMessage, partitionMessageTimeline } from '../src/lib/message-timeline.js';

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

  test('groups sub-agent and other-agent messages into the final assistant turn', () => {
    const messages = [
      { id: 'human', role: 'user', content: 'Investigate.' },
      { id: 'assistant-working', role: 'assistant', createdAt: '2026-09-01T10:00:00.000Z', content: 'Working.' },
      { id: 'other-agent', role: 'user', fromAgent: true, content: 'Agent update.' },
      { id: 'sub-agent', role: 'user', content: '<subagent_report thread_id="thread-1" title="Research">Sub-agent result.</subagent_report>' },
      { id: 'cross-thread', role: 'user', content: '<cross-message from_thread_id="thread-2">Cross-thread update.</cross-message>' },
      { id: 'assistant-final', role: 'assistant', content: 'Final answer.' },
      { id: 'next-human', role: 'user', content: 'Thanks.' },
    ];

    expect(groupAssistantTurns(messages)).toEqual([
      { message: messages[0], workedMessages: [] },
      {
        message: messages[5],
        workedMessages: messages.slice(1, 5),
        workedStartedAt: '2026-09-01T10:00:00.000Z',
      },
      { message: messages[6], workedMessages: [] },
    ]);
  });

  test('parses valid structured agent messages and rejects malformed envelopes', () => {
    expect(parseStructuredAgentMessage({ role: 'user', content: '<subagent_report title="Research" thread_id="thread-1">Result.</subagent_report>' })).toEqual({
      type: 'subagent-report', threadId: 'thread-1', title: 'Research', body: 'Result.',
    });
    expect(parseStructuredAgentMessage({ role: 'user', content: '<cross-message from_thread_id="thread-2">Update.</cross-message>' })).toEqual({
      type: 'cross-thread-message', sourceThreadId: 'thread-2', body: 'Update.',
    });

    const malformed = { id: 'malformed', role: 'user', content: '<subagent_report>Missing identity.</subagent_report>' };
    expect(parseStructuredAgentMessage(malformed)).toBeNull();
    expect(groupAssistantTurns([malformed])).toEqual([{ message: malformed, workedMessages: [] }]);
  });

  test('formats Desktop-style worked duration labels', () => {
    expect(formatWorkedDuration('2026-09-01T10:00:00.000Z', '2026-09-01T10:00:14.000Z')).toBe('Worked for 14 seconds');
    expect(formatWorkedDuration('2026-09-01T10:00:00.000Z', '2026-09-01T10:01:05.000Z')).toBe('Worked for 1m 5s');
  });
});
