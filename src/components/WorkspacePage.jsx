import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Composer } from './Composer.jsx';
import { ConversationSidebar } from './ConversationSidebar.jsx';
import { RichMessage } from './RichMessage.jsx';
import { METHODS, HISTORY_PAGE_SIZE, supportsMethod, validateDiscovery } from '../rpc/contracts.js';
import { createOlderHistoryRequest, normalizeMessagePage } from '../rpc/pagination.js';
import { applyConversationEvent, prependOlderMessages, recoverConversationState, refreshConversationProjection } from '../state/conversation.js';
import { conversationCreateParams } from '../lib/conversation-folders.js';
import { groupAssistantTurns } from '../lib/message-timeline.js';
import { moveQueueId } from '../lib/queue-actions.js';
import { conversationSocketPath, toWebSocketUrl } from '../rpc/url.js';
import { RpcClient } from '../rpc/client.js';
import { useModalFocus } from '../lib/use-modal-focus.js';

function Approval({ item, client, onDone, onError, discovery }) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  async function decide(decision) { if (submitting.current || !supportsMethod(discovery, METHODS.resolveApproval)) return; submitting.current = true; setBusy(true); try { const handled = await client.request(METHODS.resolveApproval, { approvalId: item.approvalId, decision }); if (!handled) throw new Error('This approval is no longer pending.'); onDone(); } catch (error) { onError(error); } finally { submitting.current = false; setBusy(false); } }
  return <section class="attention-card"><header><i class="ri-shield-keyhole-line" /><div><strong>{item.toolName}</strong><small>{item.invocationSummary}</small></div></header><pre>{JSON.stringify(item.input, null, 2)}</pre>{!supportsMethod(discovery, METHODS.resolveApproval) && <p>Remote approval decisions are unavailable on this Avi instance.</p>}<footer><button disabled={busy || !supportsMethod(discovery, METHODS.resolveApproval)} onClick={() => decide('disallow')}>Deny</button><button class="primary" disabled={busy || !supportsMethod(discovery, METHODS.resolveApproval)} onClick={() => decide('allow')}>Allow once</button></footer></section>;
}

function Question({ item, client, onDone, onError, discovery }) {
  const [answers, setAnswers] = useState(() => item.questions.map((question) => question.type === 'multiple_choice' ? [] : ''));
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (submitting.current || !supportsMethod(discovery, METHODS.answerQuestion)) return;
    submitting.current = true;
    setBusy(true);
    try {
      const handled = await client.request(METHODS.answerQuestion, {
        questionId: item.questionId,
        answers: item.questions.map((question, index) => ({ question: question.question, answer: answers[index] })),
      });
      if (!handled) throw new Error('This question is no longer pending.');
      onDone();
    } catch (error) { onError(error); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function cancel() {
    if (submitting.current || !supportsMethod(discovery, METHODS.answerQuestion)) return;
    submitting.current = true;
    setBusy(true);
    try { const handled = await client.request(METHODS.answerQuestion, { questionId: item.questionId, cancelled: true }); if (!handled) throw new Error('This question is no longer pending.'); onDone(); }
    catch (error) { onError(error); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <form class="attention-card question" onSubmit={submit}><header><i class="ri-questionnaire-line" /><strong>Input required</strong></header>{item.questions.map((question, index) => <fieldset key={question.question}><legend id={`${item.questionId}-question-${index}`}>{question.question}</legend>{question.type === 'free_text' ? <input type="text" aria-labelledby={`${item.questionId}-question-${index}`} required disabled={busy} value={answers[index]} onInput={(event) => setAnswers((currentAnswers) => currentAnswers.map((value, current) => current === index ? event.currentTarget.value : value))} /> : question.options.map((option) => <label key={option}><input required={question.type === 'single_choice'} disabled={busy} type={question.type === 'multiple_choice' ? 'checkbox' : 'radio'} name={`${item.questionId}-${index}`} checked={question.type === 'multiple_choice' ? answers[index].includes(option) : answers[index] === option} onChange={(event) => setAnswers((currentAnswers) => currentAnswers.map((value, current) => current !== index ? value : question.type === 'multiple_choice' ? event.currentTarget.checked ? [...value, option] : value.filter((item) => item !== option) : option))} />{option}</label>)}</fieldset>)}{!supportsMethod(discovery, METHODS.answerQuestion) && <p>Remote answers are unavailable on this Avi instance.</p>}<footer><button type="button" disabled={busy || !supportsMethod(discovery, METHODS.answerQuestion)} onClick={cancel}>Cancel</button><button type="submit" class="primary" disabled={busy || !supportsMethod(discovery, METHODS.answerQuestion) || item.questions.some((question, index) => question.type === 'multiple_choice' ? answers[index].length === 0 : !answers[index].trim())}>Submit answers</button></footer></form>;
}

function AuxiliaryPanel({ tab, state, client, discovery, modal, panelRef, onOpenConversation, onClose, onTab, onApprovalDone, onQuestionDone, onQueueOrder, onSemaphoreDone }) {
  const tabs = [['tasks', 'Tasks'], ['agents', 'Agents'], ['side', 'Side chats'], ['permissions', 'Attention']];
  const tabRefs = useRef([]);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  async function performAction(method, params, onDone) {
    if (submitting.current || !supportsMethod(discovery, method)) return;
    submitting.current = true;
    setBusy(true);
    setActionError('');
    try {
      const result = await client.request(method, params);
      if (client.closed) return;
      if (result === false) throw new Error('This action is no longer available.');
      onDone(result);
    } catch (error) { if (!client.closed) setActionError(error.message); }
    finally { submitting.current = false; setBusy(false); }
  }
  function moveTab(event, index) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    onTab(tabs[nextIndex][0]);
    tabRefs.current[nextIndex]?.focus();
  }
  async function reorderQueue(items, queueType, index, direction) {
    const moved = moveQueueId(items.map((item) => item.id), index, direction);
    if (!moved) return;
    await performAction(METHODS.reorderQueued, { queueType, messageIds: moved }, onQueueOrder);
  }
  return <aside ref={panelRef} class="auxiliary-panel" role={modal ? 'dialog' : undefined} aria-modal={modal || undefined} aria-label={modal ? 'Auxiliary panel' : undefined}><header><div role="tablist" aria-label="Auxiliary panels">{tabs.map(([id, label], index) => <button id={`aux-tab-${id}`} ref={(element) => { tabRefs.current[index] = element; }} role="tab" tabindex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls="aux-panel-content" onKeyDown={(event) => moveTab(event, index)} onClick={() => onTab(id)}>{label}{id === 'permissions' && state.approvals.length + state.questions.length > 0 && <b>{state.approvals.length + state.questions.length}</b>}</button>)}</div><button class="close-panel" aria-label="Close panel" onClick={onClose}><i class="ri-close-line" /></button></header><div id="aux-panel-content" class="aux-content" role="tabpanel" aria-labelledby={`aux-tab-${tab}`}>
    {actionError && <p class="inline-error" role="alert">{actionError}</p>}
    {tab === 'tasks' && <>{state.semaphoreWaits.length > 0 && <section class="semaphore-list"><h2>Waiting for capacity</h2>{state.semaphoreWaits.map((wait) => <div><span><strong>{wait.name}</strong><small>{wait.blocked ? wait.summary || 'Blocked' : 'Queued for a permit'}</small></span><button disabled={busy || !supportsMethod(discovery, METHODS.runSemaphoreNow)} onClick={() => performAction(METHODS.runSemaphoreNow, undefined, onSemaphoreDone)}>Run now</button><button disabled={busy || !supportsMethod(discovery, METHODS.cancelSemaphore)} onClick={() => performAction(METHODS.cancelSemaphore, undefined, onSemaphoreDone)}>Cancel wait</button></div>)}</section>}{state.queue.steer.length > 0 && <section class="queue-list"><h2>Steering prompts</h2>{state.queue.steer.map((message, index) => <div><span>{message.content || 'Steering message'}</span><button aria-label={`Move ${message.content || 'message'} up`} disabled={busy || index === 0 || !supportsMethod(discovery, METHODS.reorderQueued)} onClick={() => reorderQueue(state.queue.steer, 'steer', index, -1)}><i class="ri-arrow-up-line" /></button><button aria-label={`Move ${message.content || 'message'} down`} disabled={busy || index === state.queue.steer.length - 1 || !supportsMethod(discovery, METHODS.reorderQueued)} onClick={() => reorderQueue(state.queue.steer, 'steer', index, 1)}><i class="ri-arrow-down-line" /></button><button disabled={busy || !supportsMethod(discovery, METHODS.cancelQueued)} onClick={() => performAction(METHODS.cancelQueued, { messageId: message.id }, onQueueOrder)}>Cancel</button></div>)}</section>}{state.tasks.length ? <ol class="task-list">{state.tasks.map((task) => <li class={task.done ? 'done' : ''}><i class={task.done ? 'ri-checkbox-circle-line' : 'ri-checkbox-blank-circle-line'} /><div><strong>{task.title}</strong><p>{task.description}</p>{task.result && <small>{task.result}</small>}</div></li>)}</ol> : <p class="panel-empty">No tasks in this thread.</p>}</>}
    {tab === 'agents' && (state.subagents.length || state.rubberDucks.length ? <ul class="thread-list compact">{state.subagents.map((item) => <li><button onClick={() => onOpenConversation(item.id)}><i class="ri-git-branch-line" /><span><strong>{item.title}</strong><small>{item.workStatus ?? 'Sub-agent'}</small></span></button></li>)}{state.rubberDucks.map((item) => <li><button onClick={() => onOpenConversation(item.id)}><i class="ri-chat-smile-2-line" /><span><strong>{item.title}</strong><small>Rubber Duck</small></span></button></li>)}</ul> : <p class="panel-empty">No sub-agents or Rubber Ducks have been created.</p>)}
    {tab === 'side' && (state.sideChats.length ? <ul class="thread-list compact">{state.sideChats.map((item) => <li><button onClick={() => onOpenConversation(item.id)}><i class="ri-chat-1-line" /><span><strong>{item.title}</strong><small>Side chat</small></span></button></li>)}</ul> : <p class="panel-empty">No side chats for this thread.</p>)}
    {tab === 'permissions' && <>{state.approvals.map((item) => <Approval key={item.approvalId} item={item} client={client} discovery={discovery} onDone={() => onApprovalDone(item.approvalId)} onError={(error) => setActionError(error.message)} />)}{state.questions.map((item) => <Question key={item.questionId} item={item} client={client} discovery={discovery} onDone={() => onQuestionDone(item.questionId)} onError={(error) => setActionError(error.message)} />)}{!state.approvals.length && !state.questions.length && <p class="panel-empty">Nothing needs attention.</p>}</>}
  </div></aside>;
}

export function WorkspacePage({ connection, globalClient, discovery, models, messageDeliveryMode, conversations, folders, bots, tags, sidebarStatus, schedulerSnooze, onRefresh, onExit, connections = [], onSwitchConnection, connectionStatus, refreshError, switchingConnectionId, workspaceMemory }) {
  const localMemory = useRef(new Map());
  const memory = workspaceMemory ?? localMemory.current;
  if (!memory.has(connection.id)) memory.set(connection.id, { selectedId: null, drafts: new Map() });
  const savedWorkspace = memory.get(connection.id);
  const [selectedId, setSelectedId] = useState(savedWorkspace.selectedId ?? conversations[0]?.id ?? null);
  savedWorkspace.selectedId = selectedId;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [state, setState] = useState(recoverConversationState({}));
  const [client, setClient] = useState(null);
  const [conversationDiscovery, setConversationDiscovery] = useState(null);
  const [history, setHistory] = useState({ hasMore: false, nextCursor: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia?.('(max-width: 860px)').matches ?? false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState('tasks');
  const [collapsed, setCollapsed] = useState(false);
  const [widths, setWidths] = useState(savedWorkspace.widths ?? { sidebar: 222, panel: 420 });
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const dragRef = useRef(null);
  const sidebarWidth = Math.min(widths.sidebar, Math.max(180, viewportWidth - (panelOpen ? 280 : 0) - 320));
  const panelWidth = Math.min(widths.panel, Math.max(280, viewportWidth - (collapsed ? 58 : sidebarWidth) - 320));
  savedWorkspace.widths = widths;

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  function resizePanel(kind, value) {
    const maximum = kind === 'sidebar'
      ? Math.min(480, viewportWidth - (panelOpen ? panelWidth : 0) - 320)
      : Math.min(640, viewportWidth - (collapsed ? 58 : sidebarWidth) - 320);
    setWidths((current) => ({ ...current, [kind]: Math.max(kind === 'sidebar' ? 180 : 280, Math.min(maximum, value)) }));
  }
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [mobileComposerCompact, setMobileComposerCompact] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef();
  const chatAreaRef = useRef();
  const composerWrapRef = useRef();
  const navigationButtonRef = useRef();
  const navigationDialogRef = useRef();
  const panelButtonRef = useRef();
  const panelDialogRef = useRef();
  const initialScrollConversationId = useRef(null);
  const skipNextAutoScroll = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  function scrollToBottom(behavior = 'auto') {
    const area = scrollRef.current;
    if (!area) return;
    area.scrollTo({ top: Math.max(0, area.scrollHeight - area.clientHeight), behavior });
    if (behavior !== 'smooth') setAwayFromBottom(false);
  }

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 860px)');
    if (!query) return undefined;
    const update = (event) => {
      setMobile(event.matches);
      setMobileComposerCompact(false);
      setNavigationOpen(false);
      setPanelOpen(false);
    };
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useModalFocus({ containerRef: navigationDialogRef, returnFocusRef: navigationButtonRef, open: mobile && navigationOpen, onClose: () => setNavigationOpen(false) });
  useModalFocus({ containerRef: panelDialogRef, returnFocusRef: panelButtonRef, open: mobile && panelOpen && Boolean(client), onClose: () => setPanelOpen(false) });

  useEffect(() => { if (!selectedId && conversations[0]) setSelectedId(conversations[0].id); }, [conversations]);
  useEffect(() => {
    if (!selectedId || !supportsMethod(discovery, METHODS.markSidebarSeen)) return;
    globalClient.request(METHODS.markSidebarSeen, { conversationId: selectedId }).then(() => onRefresh()).catch(() => {});
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) {
      const emptyState = recoverConversationState({});
      stateRef.current = emptyState;
      setState(emptyState);
      setHistory({ hasMore: false, nextCursor: null });
      return;
    }
    initialScrollConversationId.current = selectedId;
    setAwayFromBottom(false);
    setMobileComposerCompact(false);
    setLoadingOlder(false);
    setHistory({ hasMore: false, nextCursor: null });
    setError('');
    const emptyState = recoverConversationState({});
    stateRef.current = emptyState;
    setState(emptyState);
    const socket = new RpcClient({ url: connection.relay ? undefined : toWebSocketUrl(connection.serverUrl, conversationSocketPath(selectedId)), relay: connection.relay, path: conversationSocketPath(selectedId), apiKey: connection.apiKey });
    setConversationDiscovery(null);
    let active = true;
    let recovering = false;
    let recoveryAttempt = 0;
    let recoveryTimer = null;
    let projectionTimer = null;
    let projectionRefreshing = false;
    let bufferedEvents = [];
    let recoveredOnce = false;
    async function recover() {
      if (recovering || !active || socket.closed) return;
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
      recovering = true;
      bufferedEvents = [];
      try {
        const capabilities = validateDiscovery(await socket.request(METHODS.discover));
        if (!active) return;
        setConversationDiscovery(capabilities);
        const context = await socket.request(METHODS.conversationContext, { limit: HISTORY_PAGE_SIZE });
        if (!active) return;
        const recovered = bufferedEvents.reduce(
          (current, notification) => applyConversationEvent(current, notification),
          recoveredOnce
            ? { ...refreshConversationProjection(stateRef.current, context), lastSequence: 0, recoveryRequired: false, error: null }
            : recoverConversationState(context),
        );
        stateRef.current = recovered;
        setState(recovered);
        if (!recoveredOnce) setHistory(normalizeMessagePage(context.messagePage ?? { messages: context.messages, hasMore: false }));
        recoveredOnce = true;
        recoveryAttempt = 0;
      } catch (value) {
        if (active) {
          const recovered = bufferedEvents.reduce(
            (current, notification) => applyConversationEvent(current, notification),
            stateRef.current,
          );
          stateRef.current = recovered;
          setState(recovered);
          setError(value.message);
          const delay = Math.min(1_000 * (2 ** recoveryAttempt++), 15_000);
          if (!socket.closed) recoveryTimer = setTimeout(recover, delay);
        }
      } finally { recovering = false; }
    }
    async function refreshProjection() {
      if (!active || recovering || projectionRefreshing || socket.closed) return;
      projectionRefreshing = true;
      try {
        const context = await socket.request(METHODS.conversationContext, { limit: 1 });
        if (!active) return;
        const next = refreshConversationProjection(stateRef.current, context);
        stateRef.current = next;
        setState(next);
      } catch (value) {
        if (active && !socket.closed) setError(value.message);
      } finally { projectionRefreshing = false; }
    }
    socket.addEventListener('notification', (event) => {
      if (!active) return;
      if (event.detail.method === 'conversation:ready') recover();
      if (event.detail.method === 'conversation:event') {
        if (recovering) {
          bufferedEvents.push(event.detail.params);
          return;
        }
        const next = applyConversationEvent(stateRef.current, event.detail.params);
        stateRef.current = next;
        setState(next);
        if (next.recoveryRequired) recover();
      }
    });
    socket.addEventListener('status', (event) => {
      if (!active) return;
      if (event.detail.status !== 'online') { setConversationDiscovery(null); setError(event.detail.error || 'Conversation connection is offline. Reconnecting...'); }
      else {
        setError('');
        if (!projectionTimer) projectionTimer = setInterval(refreshProjection, 5_000);
      }
    });
    socket.connect().catch((value) => { if (active) setError(value.message); });
    setClient(socket);
    return () => { active = false; clearTimeout(recoveryTimer); clearInterval(projectionTimer); socket.close(); setClient(null); };
  }, [selectedId, connection.id]);

  useLayoutEffect(() => {
    if (!scrollRef.current || initialScrollConversationId.current !== state.conversation?.id) return;
    scrollToBottom();
    initialScrollConversationId.current = null;
    skipNextAutoScroll.current = true;
  }, [selectedId, state.conversation?.id, state.messages]);

  useEffect(() => {
    const area = scrollRef.current;
    if (!area || initialScrollConversationId.current) return undefined;
    if (skipNextAutoScroll.current) {
      skipNextAutoScroll.current = false;
      return undefined;
    }
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 160;
    if (!nearBottom) return undefined;
    const frame = requestAnimationFrame(() => scrollToBottom());
    return () => cancelAnimationFrame(frame);
  }, [state.messages.length, state.messages.at(-1)?.content]);

  async function older() {
    const params = createOlderHistoryRequest(history);
    if (!params || !client || loadingOlder || !supportsMethod(conversationDiscovery, METHODS.conversationMessages)) return;
    const conversationId = selectedId;
    setLoadingOlder(true);
    try {
      const beforeHeight = scrollRef.current.scrollHeight;
      const page = normalizeMessagePage(await client.request(METHODS.conversationMessages, params));
      if (client.closed || selectedIdRef.current !== conversationId) return;
      const next = { ...stateRef.current, messages: prependOlderMessages(stateRef.current.messages, page.messages) };
      stateRef.current = next;
      setState(next);
      setHistory(page);
      requestAnimationFrame(() => {
        const area = scrollRef.current;
        if (area && selectedIdRef.current === conversationId) area.scrollTop += area.scrollHeight - beforeHeight;
      });
    } catch (value) {
      if (!client.closed && selectedIdRef.current === conversationId) setError(value.message);
    } finally { if (selectedIdRef.current === conversationId) setLoadingOlder(false); }
  }
  function applyQueueResult(result) {
    if (client?.closed || selectedIdRef.current !== selectedId) return;
    const byId = new Map([...stateRef.current.queue.steer, ...stateRef.current.queue.queued, ...stateRef.current.messages].map((message) => [message.id, message]));
    const next = { ...stateRef.current, queue: {
      steer: (result?.steerMessageIds ?? result?.queueOrder?.steerMessageIds ?? []).map((id) => byId.get(id)).filter(Boolean),
      queued: (result?.queuedMessageIds ?? result?.queueOrder?.queuedMessageIds ?? []).map((id) => byId.get(id)).filter(Boolean),
    } };
    stateRef.current = next;
    setState(next);
  }
  async function createSideChat() {
    if (!supportsMethod(conversationDiscovery, METHODS.createSideChat)) return;
    try {
      const result = await client.request(METHODS.createSideChat);
      if (!client.closed && selectedIdRef.current === selectedId && result?.conversation?.id) selectConversation(result.conversation.id);
    } catch (value) { setError(value.message); }
  }
  async function createConversation(folder) {
    if (!supportsMethod(discovery, METHODS.createConversation)) return;
    try {
      const item = await globalClient.request(METHODS.createConversation, conversationCreateParams(folder, models[0]?.id));
      await onRefresh(item);
      selectConversation(item.id);
    } catch (value) { setError(value.message); }
  }
  async function runSidebarAction(method, params, selectResult = null) {
    try {
      const result = await globalClient.request(method, params);
      await onRefresh(result?.conversation ?? null);
      if (selectResult) {
        const id = selectResult(result);
        if (id) selectConversation(id);
      } else if ([METHODS.archiveConversation, METHODS.deleteConversation].includes(method) && params.payload === selectedIdRef.current) {
        selectConversation(conversations.find((item) => item.id !== params.payload)?.id ?? null);
      }
      return result;
    } catch (value) {
      setError(value.message);
      throw value;
    }
  }
  function selectConversation(id) {
    selectedIdRef.current = id;
    savedWorkspace.selectedId = id;
    setSelectedId(id);
    setNavigationOpen(false);
    if (mobile) setPanelOpen(false);
  }
  const sidebarProps = {
    bots: supportsMethod(discovery, METHODS.listBots) ? bots : undefined,
    connection, connections, onSwitchConnection, switchingConnectionId, connectionStatus,
    conversations,
    folders,
    models,
    schedulerSnooze,
    selectedId,
    sidebarStatus: supportsMethod(discovery, METHODS.sidebarStatus) ? sidebarStatus : undefined,
    tags: supportsMethod(discovery, METHODS.listTags) ? tags : undefined,
    onActivateBot: supportsMethod(discovery, METHODS.activateBot) ? (bot) => runSidebarAction(METHODS.activateBot, { payload: bot.id }) : undefined,
    onArchive: supportsMethod(discovery, METHODS.archiveConversation) ? (item) => runSidebarAction(METHODS.archiveConversation, { payload: item.id }) : undefined,
    onCreate: supportsMethod(discovery, METHODS.createConversation) ? createConversation : undefined,
    onCreateBot: supportsMethod(discovery, METHODS.createBot) ? (input) => runSidebarAction(METHODS.createBot, input) : undefined,
    onDelete: supportsMethod(discovery, METHODS.deleteConversation) ? (item) => runSidebarAction(METHODS.deleteConversation, { payload: item.id }) : undefined,
    onDeleteBot: supportsMethod(discovery, METHODS.deleteBot) ? (bot) => runSidebarAction(METHODS.deleteBot, { payload: bot.id }) : undefined,
    onExit,
    onFork: supportsMethod(discovery, METHODS.forkConversation) ? (item) => runSidebarAction(METHODS.forkConversation, { payload: item.id }, (result) => result?.conversation?.id) : undefined,
    onRename: supportsMethod(discovery, METHODS.updateConversation) ? (item, title) => runSidebarAction(METHODS.updateConversation, { id: item.id, title }) : undefined,
    onSaveFolderColor: supportsMethod(discovery, METHODS.saveFolderColor) ? (folder, color) => runSidebarAction(METHODS.saveFolderColor, { path: folder.path, color }) : undefined,
    onSaveTags: supportsMethod(discovery, METHODS.saveTags) ? (nextTags) => runSidebarAction(METHODS.saveTags, { tags: nextTags }) : undefined,
    onSearch: supportsMethod(discovery, METHODS.searchConversations) ? (query) => globalClient.request(METHODS.searchConversations, { payload: query }) : undefined,
    onSelect: selectConversation,
    onSetConversationTags: supportsMethod(discovery, METHODS.setConversationTags) ? (item, nextTags) => runSidebarAction(METHODS.setConversationTags, { conversationId: item.id, tags: nextTags }) : undefined,
    onSnoozeBot: supportsMethod(discovery, METHODS.snoozeBot) ? (bot, options) => runSidebarAction(METHODS.snoozeBot, { botId: bot.id, options }) : undefined,
    onSnoozeBots: supportsMethod(discovery, METHODS.snoozeBots) ? (options) => runSidebarAction(METHODS.snoozeBots, options) : undefined,
    onUpdateBot: supportsMethod(discovery, METHODS.updateBot) ? (bot, changes) => runSidebarAction(METHODS.updateBot, { id: bot.id, changes }) : undefined,
  };
  const attentionCount = state.approvals.length + state.questions.length;
  const selectedConversation = conversations.find((item) => item.id === selectedId);
  const conversationTitle = state.conversation?.title ?? selectedConversation?.title ?? 'Start a conversation';
  const conversationFolder = state.conversation?.projectName ?? selectedConversation?.projectName ?? state.conversation?.projectDisplayPath ?? selectedConversation?.projectDisplayPath ?? 'Chats';
  const closeNavigation = () => {
    setNavigationOpen(false);
    requestAnimationFrame(() => navigationButtonRef.current?.focus());
  };
  const closePanel = () => {
    setPanelOpen(false);
    if (mobile) requestAnimationFrame(() => panelButtonRef.current?.focus());
  };
  useEffect(() => {
    const chatArea = chatAreaRef.current;
    const composerWrap = composerWrapRef.current;
    if (!chatArea || !composerWrap || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.borderBoxSize?.blockSize ?? entry.contentRect.height;
      const area = scrollRef.current;
      const wasAtBottom = area && area.scrollHeight - area.scrollTop - area.clientHeight < 2;
      chatArea.style.setProperty('--composer-clearance', `${Math.ceil(height)}px`);
      if (wasAtBottom) requestAnimationFrame(() => scrollToBottom());
    });
    observer.observe(composerWrap);
    return () => {
      observer.disconnect();
      chatArea.style.removeProperty('--composer-clearance');
    };
  }, [client, state.conversation?.id]);

  const visibleMessages = state.messages.filter((message) => !message.hidden && !['queued', 'steered'].includes(message.status));
  const groupedMessages = groupAssistantTurns(visibleMessages);
  return <main class={`workspace ${collapsed ? 'sidebar-collapsed' : ''} ${panelOpen ? 'panel-open' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px`, '--panel-width': `${panelWidth}px` }}>
    {!mobile && ['sidebar', ...(panelOpen && client ? ['panel'] : [])].filter((kind) => kind !== 'sidebar' || !collapsed).map((kind) => <div key={kind} class={`panel-resizer ${kind}-resizer`} role="separator" tabindex="0" aria-label={`Resize ${kind === 'sidebar' ? 'sidebar' : 'auxiliary panel'}`} aria-orientation="vertical" aria-valuemin={kind === 'sidebar' ? 180 : 280} aria-valuemax={kind === 'sidebar' ? Math.min(480, viewportWidth - (panelOpen ? panelWidth : 0) - 320) : Math.min(640, viewportWidth - (collapsed ? 58 : sidebarWidth) - 320)} aria-valuenow={kind === 'sidebar' ? sidebarWidth : panelWidth}
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { kind, x: event.clientX, width: kind === 'sidebar' ? sidebarWidth : panelWidth }; }}
      onPointerMove={(event) => { const drag = dragRef.current; if (drag?.kind === kind) resizePanel(kind, drag.width + (event.clientX - drag.x) * (kind === 'sidebar' ? 1 : -1)); }}
      onPointerUp={(event) => { dragRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}
      onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10) * (kind === 'sidebar' ? 1 : -1); resizePanel(kind, event.key === 'Home' ? 0 : event.key === 'End' ? Infinity : (kind === 'sidebar' ? sidebarWidth : panelWidth) + delta); }}
    />)}
    <p class="sr-only" role="status" aria-live="polite">{attentionCount ? `${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention.` : 'No items need attention.'}</p>
    <ConversationSidebar {...sidebarProps} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} />
    <section class="chat-area" ref={chatAreaRef}>
      <header class="workspace-header mobile-header">
        <button class="navigation-trigger" ref={navigationButtonRef} aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><i class="ri-menu-line" /></button>
        <div class="workspace-heading"><strong title={conversationTitle}>{conversationTitle}</strong><small title={conversationFolder}>{conversationFolder}</small></div>
        <button ref={panelButtonRef} aria-label={panelOpen ? 'Close auxiliary panel' : 'Open auxiliary panel'} aria-haspopup={mobile ? 'dialog' : undefined} aria-expanded={panelOpen} onClick={() => { setPanelOpen(!panelOpen); if (attentionCount) setPanelTab('permissions'); }}><i class="ri-layout-right-line" />{attentionCount > 0 && <b>{attentionCount}</b>}</button>
      </header>
      {(refreshError || (connectionStatus && connectionStatus.status !== 'online')) && <div class="workspace-connection-alert" role="alert"><span>{refreshError || connectionStatus.error || connectionStatus.detail || 'Connection interrupted. Reconnecting; displayed data may be out of date.'}</span><button onClick={() => onRefresh().catch((value) => setError(value.message))}>Retry</button></div>}
      {(error || state.error) && <div class="workspace-connection-alert" role="alert"><span>{error || state.error}</span><button onClick={() => {
        setError('');
        const next = { ...stateRef.current, error: null };
        stateRef.current = next;
        setState(next);
      }} aria-label="Dismiss error"><i class="ri-close-line" /></button></div>}
      <div class="conversation-scroll" ref={scrollRef} role="region" tabindex="0" aria-label="Conversation messages" onScroll={() => {
        const area = scrollRef.current;
        if (area) setAwayFromBottom(area.scrollHeight - area.scrollTop - area.clientHeight > 48);
      }} onTouchMove={() => { if (mobile) setMobileComposerCompact(true); }} onWheel={() => { if (mobile) setMobileComposerCompact(true); }} onKeyDown={(event) => {
        if (mobile && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) setMobileComposerCompact(true);
      }}>{history.hasMore && <button class="load-older" title={!supportsMethod(conversationDiscovery, METHODS.conversationMessages) ? 'Earlier messages are not available on this Avi instance.' : undefined} disabled={loadingOlder || !supportsMethod(conversationDiscovery, METHODS.conversationMessages)} onClick={older}>{loadingOlder ? 'Loading...' : 'Load earlier messages'}</button>}{groupedMessages.length ? <div class="messages-column">{groupedMessages.map(({ message, workedMessages, workedStartedAt }) => <RichMessage key={message.id} message={message} workedMessages={workedMessages} workedStartedAt={workedStartedAt} client={client} discovery={conversationDiscovery} onFork={supportsMethod(discovery, METHODS.forkConversation) ? async (messageId) => {
        const result = await runSidebarAction(METHODS.forkConversation, { payload: { conversationId: selectedId, throughMessageId: messageId } }, (value) => value?.conversation?.id);
        if (!result?.conversation?.id) throw new Error('Avi could not fork this conversation.');
      } : undefined} />)}</div> : <div class="empty-chat"><span class="avi-mark large"><img src="avi.png" alt="" width="34" height="34" /></span><h1>{conversationTitle}</h1><p>Remote state stays authoritative on {connection.label}.</p></div>}</div>
      {awayFromBottom && <button type="button" class="scroll-to-bottom" aria-label="Scroll to latest message" title="Scroll to latest message" onClick={() => scrollToBottom('smooth')}><i class="ri-arrow-down-line" /></button>}
      {client && state.conversation && <Composer key={state.conversation.id} client={client} state={state} discovery={conversationDiscovery} draftCache={savedWorkspace.drafts} models={models} messageDeliveryMode={messageDeliveryMode} compact={mobile && mobileComposerCompact} onExpand={() => {
        setMobileComposerCompact(false);
        requestAnimationFrame(() => composerWrapRef.current?.querySelector('textarea')?.focus());
      }} onSent={onRefresh} onStop={() => client.request(METHODS.stop)} onSideChat={createSideChat} onOpenTasks={() => { setPanelTab('tasks'); setPanelOpen(true); }} onOpenAgents={() => { setPanelTab('agents'); setPanelOpen(true); }} onQueueOrder={applyQueueResult} onError={(value) => setError(value.message)} composerRef={composerWrapRef} />}
    </section>
    {mobile && navigationOpen && <div ref={navigationDialogRef} class="mobile-navigation-layer">
      <div class="mobile-drawer" role="dialog" aria-modal="true" aria-label="Navigation"><ConversationSidebar {...sidebarProps} collapsed={false} onClose={closeNavigation} /></div>
      <div class="mobile-overlay-backdrop" aria-hidden="true" onClick={closeNavigation} />
    </div>}
    {panelOpen && client && <AuxiliaryPanel key={selectedId} discovery={conversationDiscovery} modal={mobile} panelRef={panelDialogRef} tab={panelTab} state={state} client={client} onOpenConversation={selectConversation} onClose={closePanel} onTab={setPanelTab} onApprovalDone={(approvalId) => { if (client.closed || selectedIdRef.current !== selectedId) return; const next = { ...stateRef.current, approvals: stateRef.current.approvals.filter((item) => item.approvalId !== approvalId) }; stateRef.current = next; setState(next); }} onQuestionDone={(questionId) => { if (client.closed || selectedIdRef.current !== selectedId) return; const next = { ...stateRef.current, questions: stateRef.current.questions.filter((item) => item.questionId !== questionId) }; stateRef.current = next; setState(next); }} onQueueOrder={applyQueueResult} onSemaphoreDone={() => { if (client.closed || selectedIdRef.current !== selectedId) return; const next = { ...stateRef.current, semaphoreWaits: [] }; stateRef.current = next; setState(next); }} />}
    <div class="version-bar">Avi {discovery.appVersion}{discovery.versions?.core != null && ` · Core v${discovery.versions.core}`}{discovery.versions?.mcp?.latest != null && ` · MCP ${discovery.versions.mcp.latest}`} · RPC v{discovery.apiVersion}</div>
  </main>;
}
