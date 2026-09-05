const OPERATIONAL_TYPES = new Set(['reasoning', 'tool-call', 'tool-result', 'error']);

// Textual thinking blocks embedded in aggregate assistant content, as emitted by
// the Desktop pipeline (<think>, <thinking-group|blocks|block>, <tool>,
// <assistant-answer>). Parsed so reasoning collapses instead of rendering inline.
const THINKING_MARKERS = [
  { type: 'group', openTag: '<thinking-group>', closeTag: '</thinking-group>' },
  { type: 'group', openTag: '<thinking-blocks>', closeTag: '</thinking-blocks>' },
  { type: 'group', openTag: '<thinking-block>', closeTag: '</thinking-block>' },
  { type: 'think', openTag: '<think>', closeTag: '</think>' },
  { type: 'tool', openTag: '<tool>', closeTag: '</tool>' },
  { type: 'answer', openTag: '<assistant-answer>', closeTag: '</assistant-answer>' },
];

function findTag(text, tag, start) {
  return text.indexOf(tag, start);
}

function nearestPositive(a, b) {
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function decodeXmlEntities(text) {
  return String(text ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function stripTags(text) {
  return decodeXmlEntities(String(text ?? '').replace(/<\/?[^>]+>/g, ''));
}

function tagValue(text, tagName) {
  const startTag = `<${tagName}>`;
  const endTag = `</${tagName}>`;
  const start = findTag(text, startTag, 0);
  if (start < 0) return '';
  const valueStart = start + startTag.length;
  const end = findTag(text, endTag, valueStart);
  return stripTags(end >= 0 ? text.slice(valueStart, end) : text.slice(valueStart)).trim();
}

function toolResultName(text) {
  const match = /data-tool-name=["']([^"']*)["']/i.exec(text);
  if (match) return decodeXmlEntities(match[1]).trim();
  return tagValue(text, 'b') || 'tool';
}

function isStatusOnlyText(text) {
  const source = String(text ?? '');
  const statuses = [...source.matchAll(/\*\*((?:(?!\*\*)[^\r\n])+)\*\*/g)];
  if (
    statuses.length === 0
    || statuses.map((status) => status[0]).join('') !== source
    || statuses.some((status) => !status[1] || status[1].trim() !== status[1])
  ) return false;
  return true;
}

function pushParsedReasoning(items, text, sequence) {
  if (isStatusOnlyText(text)) return;
  const normalized = stripTags(text).trim();
  if (!normalized) return;
  items.push({ id: `reasoning-${sequence}-${items.length}`, type: 'reasoning', text: normalized });
}

function pushParsedTool(items, tool, sequence) {
  const detail = stripTags(tool.reason ?? '').trim();
  items.push({
    id: `reasoning-${sequence}-${items.length}`,
    type: 'reasoning',
    text: detail ? `**${tool.name}**: ${detail}` : `**${tool.name}**`,
  });
}

function findNextThinkingMarker(text, start) {
  let found = null;
  for (const marker of THINKING_MARKERS) {
    const position = findTag(text, marker.openTag, start);
    if (position < 0) continue;
    if (!found || position < found.start) found = { ...marker, start: position };
  }
  return found;
}

function parseThinkingGroup(body, sequence, keepTools) {
  const items = [];
  let cursor = 0;
  while (cursor < body.length) {
    const thinkStart = findTag(body, '<think>', cursor);
    const toolStart = findTag(body, '<tool>', cursor);
    const toolResultStart = findTag(body, '<div class="tool-result', cursor);
    const nextStart = nearestPositive(thinkStart, nearestPositive(toolStart, toolResultStart));
    if (nextStart < 0) {
      pushParsedReasoning(items, body.slice(cursor), sequence);
      break;
    }
    pushParsedReasoning(items, body.slice(cursor, nextStart), sequence);
    if (nextStart === thinkStart) {
      const valueStart = thinkStart + '<think>'.length;
      const valueEnd = findTag(body, '</think>', valueStart);
      pushParsedReasoning(items, valueEnd >= 0 ? body.slice(valueStart, valueEnd) : body.slice(valueStart), sequence);
      cursor = valueEnd >= 0 ? valueEnd + '</think>'.length : body.length;
      continue;
    }
    if (nextStart === toolStart) {
      const valueStart = toolStart + '<tool>'.length;
      const valueEnd = findTag(body, '</tool>', valueStart);
      const toolBody = valueEnd >= 0 ? body.slice(valueStart, valueEnd) : body.slice(valueStart);
      if (keepTools) pushParsedTool(items, { name: tagValue(toolBody, 'toolname') || 'tool', reason: tagValue(toolBody, 'toolreason') || stripTags(toolBody).trim() }, sequence);
      cursor = valueEnd >= 0 ? valueEnd + '</tool>'.length : body.length;
      continue;
    }
    const valueEnd = findTag(body, '</div>', toolResultStart);
    const toolBody = valueEnd >= 0 ? body.slice(toolResultStart, valueEnd + '</div>'.length) : body.slice(toolResultStart);
    if (keepTools) pushParsedTool(items, { name: toolResultName(toolBody), reason: tagValue(toolBody, 'span') || stripTags(toolBody).replace(toolResultName(toolBody), '').trim() }, sequence);
    cursor = valueEnd >= 0 ? valueEnd + '</div>'.length : body.length;
  }
  return items;
}

function parseThinkingMarker(content, marker, sequence, keepTools) {
  if (marker.type === 'think') {
    const valueStart = marker.start + '<think>'.length;
    const valueEnd = findTag(content, '</think>', valueStart);
    const items = [];
    pushParsedReasoning(items, valueEnd >= 0 ? content.slice(valueStart, valueEnd) : content.slice(valueStart), sequence);
    return { items, nextCursor: valueEnd >= 0 ? valueEnd + '</think>'.length : content.length };
  }
  if (marker.type === 'tool') {
    const valueStart = marker.start + '<tool>'.length;
    const valueEnd = findTag(content, '</tool>', valueStart);
    const toolBody = valueEnd >= 0 ? content.slice(valueStart, valueEnd) : content.slice(valueStart);
    const items = [];
    if (keepTools) pushParsedTool(items, { name: tagValue(toolBody, 'toolname') || 'tool', reason: tagValue(toolBody, 'toolreason') || stripTags(toolBody).trim() }, sequence);
    return { items, nextCursor: valueEnd >= 0 ? valueEnd + '</tool>'.length : content.length };
  }
  const groupBodyStart = marker.start + marker.openTag.length;
  const groupEnd = findTag(content, marker.closeTag, groupBodyStart);
  return {
    items: parseThinkingGroup(groupEnd >= 0 ? content.slice(groupBodyStart, groupEnd) : content.slice(groupBodyStart), sequence, keepTools),
    nextCursor: groupEnd >= 0 ? groupEnd + marker.closeTag.length : content.length,
  };
}

function pushSplitContent(timeline, text) {
  if (!text) return;
  const previous = timeline.at(-1);
  if (previous?.type === 'content') previous.text += text;
  else timeline.push({ type: 'content', text });
}

function splitEmbeddedThinking(raw, keepTools) {
  const timeline = [];
  let cursor = 0;
  let sequence = 0;
  while (cursor < raw.length) {
    const marker = findNextThinkingMarker(raw, cursor);
    if (!marker) {
      pushSplitContent(timeline, raw.slice(cursor));
      break;
    }
    pushSplitContent(timeline, raw.slice(cursor, marker.start));
    if (marker.type === 'answer') {
      const valueStart = marker.start + marker.openTag.length;
      const valueEnd = findTag(raw, marker.closeTag, valueStart);
      pushSplitContent(timeline, valueEnd >= 0 ? raw.slice(valueStart, valueEnd) : raw.slice(valueStart));
      cursor = valueEnd >= 0 ? valueEnd + marker.closeTag.length : raw.length;
      continue;
    }
    const parsed = parseThinkingMarker(raw, marker, sequence, keepTools);
    sequence += 1;
    if (parsed.items.length > 0) {
      const previous = timeline.at(-1);
      if (previous?.type === 'operations') previous.items.push(...parsed.items);
      else timeline.push({ type: 'operations', items: parsed.items });
    }
    cursor = parsed.nextCursor;
  }
  return timeline;
}

export function buildMessageTimeline(message) {
  const segments = Array.isArray(message?.segments) ? message.segments : [];
  const hasCanonicalText = segments.some((segment) => segment?.type === 'content');
  const timeline = [];
  let operationalItems = [];

  const flushOperational = () => {
    if (!operationalItems.length) return;
    timeline.push({ type: 'operations', items: operationalItems });
    operationalItems = [];
  };

  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;

    if (segment.type === 'content') {
      flushOperational();
      const text = String(segment.text ?? segment.content ?? '');
      if (!text) continue;
      const previous = timeline.at(-1);
      if (previous?.type === 'content') previous.text += text;
      else timeline.push({ type: 'content', text });
      continue;
    }

    if (OPERATIONAL_TYPES.has(segment.type)) {
      operationalItems.push(segment.type === 'tool-result' ? {
        ...segment,
        type: 'tool-call',
        name: segment.name ?? segment.toolName ?? 'tool',
        resultText: segment.resultText ?? segment.content ?? '',
        status: segment.status ?? 'completed',
      } : segment);
      continue;
    }

    flushOperational();
    timeline.push(segment.type?.includes('diff') || segment.diff
      ? { type: 'diff', segment }
      : { type: 'segment', segment });
  }

  flushOperational();

  if (!hasCanonicalText && message?.content) {
    const raw = String(message.content);
    if (findNextThinkingMarker(raw, 0)) {
      for (const item of splitEmbeddedThinking(raw, false)) {
        if (item.type === 'operations') {
          const reasoningItems = item.items.filter((entry) => entry?.type === 'reasoning' && String(entry.text ?? '').trim());
          if (reasoningItems.length) timeline.push({ type: 'operations', items: reasoningItems });
          continue;
        }
        if (item.type === 'content' && !item.text.trim()) continue;
        const previous = timeline.at(-1);
        if (item.type === 'content' && previous?.type === 'content') previous.text += item.text;
        else timeline.push(item);
      }
    } else {
      timeline.push({ type: 'content', text: raw });
    }
  }

  return timeline;
}

export function operationGroupHasTools(items) {
  return items.some((item) => item.type === 'tool-call');
}

export function operationGroupLabel(items) {
  const tools = items.filter((item) => item.type === 'tool-call');
  const hasReasoning = items.some((item) => item.type === 'reasoning' && String(item.text ?? item.content ?? '').trim());
  if (hasReasoning && tools.length) return `Thought, called ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
  if (hasReasoning) return 'Thought';
  if (tools.length) return `Called ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
  return 'Details';
}

export function partitionMessageTimeline(timeline, streaming = false) {
  if (streaming) return { workedItems: [], finalItems: timeline };
  const lastOperationsIndex = timeline.findLastIndex((item) => item.type === 'operations');
  if (lastOperationsIndex < 0 || !timeline.slice(lastOperationsIndex + 1).some((item) => item.type === 'content' && item.text.trim())) {
    return { workedItems: [], finalItems: timeline };
  }
  return {
    workedItems: timeline.slice(0, lastOperationsIndex + 1),
    finalItems: timeline.slice(lastOperationsIndex + 1),
  };
}

export function parseStructuredAgentMessage(message) {
  if (message?.role !== 'user') return null;
  const content = String(message.content ?? '').trim();
  const subagentReport = /^<subagent_report\b([^>]*)>\s*([\s\S]*?)\s*<\/subagent_report>$/.exec(content);
  if (subagentReport) {
    const threadId = /\bthread_id="([^"]+)"/.exec(subagentReport[1])?.[1];
    const title = /\btitle="([^"]+)"/.exec(subagentReport[1])?.[1];
    if (threadId && title) return { type: 'subagent-report', threadId, title, body: subagentReport[2] };
  }

  const crossThreadMessage = /^<cross-message\b([^>]*)>\s*([\s\S]*?)\s*<\/cross-message>$/.exec(content);
  if (crossThreadMessage) {
    const sourceThreadId = /\bfrom_thread_id="([^"]+)"/.exec(crossThreadMessage[1])?.[1];
    if (sourceThreadId) return { type: 'cross-thread-message', sourceThreadId, body: crossThreadMessage[2] };
  }

  return null;
}

export function groupAssistantTurns(messages) {
  const grouped = [];
  let turn = [];

  const flushTurn = () => {
    if (!turn.length) return;
    const finalAssistantIndex = turn.findLastIndex((message) => message.role === 'assistant');
    if (finalAssistantIndex < 0) {
      grouped.push(...turn.map((message) => ({ message, workedMessages: [] })));
      turn = [];
      return;
    }

    grouped.push({
      message: turn[finalAssistantIndex],
      workedMessages: turn.filter((_, index) => index !== finalAssistantIndex),
      workedStartedAt: turn.find((message) => message.role === 'assistant')?.createdAt,
    });
    turn = [];
  };

  for (const message of messages) {
    if (message?.role === 'assistant' || message?.fromAgent === true || parseStructuredAgentMessage(message)) {
      turn.push(message);
      continue;
    }
    flushTurn();
    grouped.push({ message, workedMessages: [] });
  }
  flushTurn();

  return grouped;
}

export function formatWorkedDuration(startValue, endValue) {
  const start = Date.parse(startValue);
  const end = Date.parse(endValue);
  const seconds = Math.max(1, Math.round(((Number.isFinite(end) ? end : Date.now()) - start) / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) {
    const safeSeconds = Number.isFinite(seconds) ? seconds : 1;
    return `Worked for ${safeSeconds} ${safeSeconds === 1 ? 'second' : 'seconds'}`;
  }
  return `Worked for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
