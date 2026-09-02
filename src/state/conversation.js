export const emptyConversationState = Object.freeze({
  conversation: null,
  messages: [],
  queue: { steer: [], queued: [] },
  run: { active: false, startedAt: null },
  approvals: [],
  questions: [],
  semaphoreWaits: [],
  tasks: [],
  sideChats: [],
  subagents: [],
  rubberDucks: [],
  composer: null,
  contextUsage: { tokens: 0, limit: null },
  error: null,
  lastSequence: 0,
});

function upsertById(items, item) {
  const id = item?.id;
  if (!id) return items;
  const index = items.findIndex((candidate) => candidate.id === id);
  if (index < 0) return [...items, item];
  return items.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ...item } : candidate);
}

export function recoverConversationState(context, lastSequence = 0) {
  return {
    ...emptyConversationState,
    ...context,
    messages: [...(context?.messages ?? [])],
    queue: {
      steer: [...(context?.queue?.steer ?? [])],
      queued: [...(context?.queue?.queued ?? [])],
    },
    run: {
      active: Boolean(context?.run?.active),
      startedAt: context?.run?.startedAt ?? null,
    },
    approvals: [...(context?.approvals ?? [])],
    questions: [...(context?.questions ?? [])],
    semaphoreWaits: [...(context?.semaphoreWaits ?? [])],
    tasks: [...(context?.tasks ?? [])],
    sideChats: [...(context?.sideChats ?? [])],
    subagents: [...(context?.subagents ?? [])],
    rubberDucks: [...(context?.rubberDucks ?? [])],
    composer: context?.composer ?? null,
    contextUsage: {
      tokens: Number(context?.contextUsage?.tokens) || 0,
      limit: Number(context?.contextUsage?.limit) || null,
    },
    error: null,
    lastSequence,
  };
}

export function refreshConversationProjection(state, context) {
  const recovered = recoverConversationState(context, state.lastSequence);
  const refreshedMessages = new Map(recovered.messages.map((message) => [message.id, message]));
  const localMessageIds = new Set(state.messages.map((message) => message.id));
  return {
    ...recovered,
    messages: [
      ...state.messages.map((message) => refreshedMessages.get(message.id) ?? message),
      ...recovered.messages.filter((message) => !localMessageIds.has(message.id)),
    ],
    composer: state.composer,
    error: state.error,
    recoveryRequired: state.recoveryRequired,
  };
}

export function applyConversationEvent(state, notification) {
  const sequence = Number(notification?.sequence ?? 0);
  if (sequence <= state.lastSequence) return state;
  if (state.lastSequence && sequence !== state.lastSequence + 1) return { ...state, recoveryRequired: true };
  const event = notification?.event ?? {};
  const next = { ...state, lastSequence: sequence, recoveryRequired: false };
  switch (event.type) {
    case 'message':
      return { ...next, messages: upsertById(state.messages, event.message) };
    case 'message-delete':
      return { ...next, messages: state.messages.filter((message) => message.id !== event.messageId) };
    case 'conversation':
      return { ...next, conversation: { ...state.conversation, ...event.conversation } };
    case 'run-state':
      return { ...next, run: { active: Boolean(event.running), startedAt: event.startedAt ?? null } };
    case 'queue-order': {
      const byId = new Map([...state.queue.steer, ...state.queue.queued, ...state.messages].map((message) => [message.id, message]));
      return { ...next, queue: {
        steer: (event.steerMessageIds ?? []).map((id) => byId.get(id)).filter(Boolean),
        queued: (event.queuedMessageIds ?? []).map((id) => byId.get(id)).filter(Boolean),
      } };
    }
    case 'tasks':
      return { ...next, tasks: [...(event.tasks ?? [])] };
    case 'semaphore-state':
      return { ...next, semaphoreWaits: (event.waits ?? []).filter((wait) => wait.conversationId === state.conversation?.id) };
    case 'permission-request':
      return { ...next, approvals: upsertById(state.approvals.map((item) => ({ ...item, id: item.approvalId })), { ...event, id: event.approvalId }).map(({ id, ...item }) => item) };
    case 'permission-cancelled':
    case 'permission-resolved':
      return { ...next, approvals: state.approvals.filter((item) => item.approvalId !== event.approvalId) };
    case 'question-request':
      return { ...next, questions: [...state.questions.filter((item) => item.questionId !== event.questionId), event] };
    case 'question-cancelled':
      return { ...next, questions: state.questions.filter((item) => item.questionId !== event.questionId) };
    case 'subagent-created':
      return { ...next, subagents: upsertById(state.subagents, event.subagent) };
    case 'rubber-duck-created':
      return { ...next, rubberDucks: upsertById(state.rubberDucks, event.rubberDuck) };
    case 'error':
      return { ...next, error: event.message || 'Conversation execution failed.' };
    default:
      return next;
  }
}

export function prependOlderMessages(current, older) {
  const seen = new Set(current.map((message) => message.id));
  return [...older.filter((message) => !seen.has(message.id)), ...current];
}
