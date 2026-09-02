export function moveQueueId(messageIds, index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= messageIds.length) return null;
  const moved = [...messageIds];
  [moved[index], moved[nextIndex]] = [moved[nextIndex], moved[index]];
  return moved;
}

export function steerQueuedParams(items, messageId) {
  return { queueType: 'queue', messageIds: items.map((item) => item.id), steerMessageId: messageId };
}
