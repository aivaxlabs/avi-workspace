import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Composer } from './Composer.jsx';
import { ConversationSidebar } from './ConversationSidebar.jsx';
import { RichMessage } from './RichMessage.jsx';
import { METHODS, HISTORY_PAGE_SIZE, supportsMethod } from '../rpc/contracts.js';
import { createOlderHistoryRequest, normalizeMessagePage } from '../rpc/pagination.js';
import { applyConversationEvent, prependOlderMessages, recoverConversationState, refreshConversationProjection } from '../state/conversation.js';
import { conversationCreateParams } from '../lib/conversation-folders.js';
import { moveQueueId } from '../lib/queue-actions.js';
import { conversationSocketPath, toWebSocketUrl } from '../rpc/url.js';
import { RpcClient } from '../rpc/client.js';

function Approval({ item, client, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  async function decide(decision) { if (submitting.current) return; submitting.current = true; setBusy(true); try { const handled = await client.request(METHODS.resolveApproval, { approvalId: item.approvalId, decision }); if (!handled) throw new Error('This approval is no longer pending.'); onDone(); } catch (error) { onError(error); } finally { submitting.current = false; setBusy(false); } }
  return <section class="attention-card"><header><i class="ri-shield-keyhole-line" /><div><strong>{item.toolName}</strong><small>{item.invocationSummary}</small></div></header><pre>{JSON.stringify(item.input, null, 2)}</pre><footer><button disabled={busy} onClick={() => decide('disallow')}>Deny</button><button class="primary" disabled={busy} onClick={() => decide('allow')}>Allow once</button></footer></section>;
}

function Question({ item, client, onDone, onError }) {
  const [answers, setAnswers] = useState(() => item.questions.map((question) => question.type === 'multiple_choice' ? [] : ''));
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
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
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try { const handled = await client.request(METHODS.answerQuestion, { questionId: item.questionId, cancelled: true }); if (!handled) throw new Error('This question is no longer pending.'); onDone(); }
    catch (error) { onError(error); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <form class="attention-card question" onSubmit={submit}><header><i class="ri-questionnaire-line" /><strong>Input required</strong></header>{item.questions.map((question, index) => <fieldset key={question.question}><legend id={`${item.questionId}-question-${index}`}>{question.question}</legend>{question.type === 'free_text' ? <input type="text" aria-labelledby={`${item.questionId}-question-${index}`} required disabled={busy} value={answers[index]} onInput={(event) => setAnswers((currentAnswers) => currentAnswers.map((value, current) => current === index ? event.currentTarget.value : value))} /> : question.options.map((option) => <label key={option}><input required={question.type === 'single_choice'} disabled={busy} type={question.type === 'multiple_choice' ? 'checkbox' : 'radio'} name={`${item.questionId}-${index}`} checked={question.type === 'multiple_choice' ? answers[index].includes(option) : answers[index] === option} onChange={(event) => setAnswers((currentAnswers) => currentAnswers.map((value, current) => current !== index ? value : question.type === 'multiple_choice' ? event.currentTarget.checked ? [...value, option] : value.filter((item) => item !== option) : option))} />{option}</label>)}</fieldset>)}<footer><button type="button" disabled={busy} onClick={cancel}>Cancel</button><button type="submit" class="primary" disabled={busy || item.questions.some((question, index) => question.type === 'multiple_choice' ? answers[index].length === 0 : !answers[index].trim())}>Submit answers</button></footer></form>;
}

function AuxiliaryPanel({ tab, state, client, modal, panelRef, onOpenConversation, onClose, onTab, onApprovalDone, onQuestionDone, onQueueOrder, onSemaphoreDone, onError }) {
  const tabs = [['tasks', 'Tasks'], ['agents', 'Agents'], ['side', 'Side chats'], ['permissions', 'Attention']];
  const tabRefs = useRef([]);
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
    try { onQueueOrder(await client.request(METHODS.reorderQueued, { queueType, messageIds: moved })); }
    catch (error) { onError(error); }
  }
  return <aside ref={panelRef} class="auxiliary-panel" role={modal ? 'dialog' : undefined} aria-modal={modal || undefined} aria-label={modal ? 'Auxiliary panel' : undefined}><header><div role="tablist" aria-label="Auxiliary panels">{tabs.map(([id, label], index) => <button id={`aux-tab-${id}`} ref={(element) => { tabRefs.current[index] = element; }} role="tab" tabindex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls="aux-panel-content" onKeyDown={(event) => moveTab(event, index)} onClick={() => onTab(id)}>{label}{id === 'permissions' && state.approvals.length + state.questions.length > 0 && <b>{state.approvals.length + state.questions.length}</b>}</button>)}</div><button class="close-panel" aria-label="Close panel" onClick={onClose}><i class="ri-close-line" /></button></header><div id="aux-panel-content" class="aux-content" role="tabpanel" aria-labelledby={`aux-tab-${tab}`}>
    {tab === 'tasks' && <>{state.semaphoreWaits.length > 0 && <section class="semaphore-list"><h2>Waiting for capacity</h2>{state.semaphoreWaits.map((wait) => <div><span><strong>{wait.name}</strong><small>{wait.blocked ? wait.summary || 'Blocked' : 'Queued for a permit'}</small></span><button onClick={() => client.request(METHODS.runSemaphoreNow).then((handled) => { if (!handled) throw new Error('This semaphore wait is no longer pending.'); onSemaphoreDone(); }).catch(onError)}>Run now</button><button onClick={() => client.request(METHODS.cancelSemaphore).then((handled) => { if (!handled) throw new Error('This semaphore wait is no longer pending.'); onSemaphoreDone(); }).catch(onError)}>Cancel wait</button></div>)}</section>}{state.queue.steer.length > 0 && <section class="queue-list"><h2>Steering prompts</h2>{state.queue.steer.map((message, index) => <div><span>{message.content || 'Steering message'}</span><button aria-label={`Move ${message.content || 'message'} up`} disabled={index === 0} onClick={() => reorderQueue(state.queue.steer, 'steer', index, -1)}><i class="ri-arrow-up-line" /></button><button aria-label={`Move ${message.content || 'message'} down`} disabled={index === state.queue.steer.length - 1} onClick={() => reorderQueue(state.queue.steer, 'steer', index, 1)}><i class="ri-arrow-down-line" /></button><button onClick={() => client.request(METHODS.cancelQueued, { messageId: message.id }).then(onQueueOrder).catch(onError)}>Cancel</button></div>)}</section>}{state.tasks.length ? <ol class="task-list">{state.tasks.map((task) => <li class={task.done ? 'done' : ''}><i class={task.done ? 'ri-checkbox-circle-line' : 'ri-checkbox-blank-circle-line'} /><div><strong>{task.title}</strong><p>{task.description}</p>{task.result && <small>{task.result}</small>}</div></li>)}</ol> : <p class="panel-empty">No tasks in this thread.</p>}</>}
    {tab === 'agents' && (state.subagents.length || state.rubberDucks.length ? <ul class="thread-list compact">{state.subagents.map((item) => <li><button onClick={() => onOpenConversation(item.id)}><i class="ri-git-branch-line" /><span><strong>{item.title}</strong><small>{item.workStatus ?? 'Sub-agent'}</small></span></button></li>)}{state.rubberDucks.map((item) => <li><button onClick={() => onOpenConversation(item.id)}><i class="ri-chat-smile-2-line" /><span><strong>{item.title}</strong><small>Rubber Duck</small></span></button></li>)}</ul> : <p class="panel-empty">No sub-agents or Rubber Ducks have been created.</p>)}
    {tab === 'side' && (state.sideChats.length ? <ul class="thread-list compact">{state.sideChats.map((item) => <li><button onClick={() => onOpenConversation(item.id)}><i class="ri-chat-1-line" /><span><strong>{item.title}</strong><small>Side chat</small></span></button></li>)}</ul> : <p class="panel-empty">No side chats for this thread.</p>)}
    {tab === 'permissions' && <>{state.approvals.map((item) => <Approval item={item} client={client} onDone={() => onApprovalDone(item.approvalId)} onError={onError} />)}{state.questions.map((item) => <Question item={item} client={client} onDone={() => onQuestionDone(item.questionId)} onError={onError} />)}{!state.approvals.length && !state.questions.length && <p class="panel-empty">Nothing needs attention.</p>}</>}
  </div></aside>;
}

export function WorkspacePage({ connection, globalClient, discovery, models, messageDeliveryMode, conversations, folders, bots, tags, sidebarStatus, schedulerSnooze, onRefresh, onExit }) {
  const [selectedId, setSelectedId] = useState(conversations[0]?.id ?? null);
  const [state, setState] = useState(recoverConversationState({}));
  const [client, setClient] = useState(null);
  const [history, setHistory] = useState({ hasMore: false, nextCursor: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia?.('(max-width: 640px)').matches ?? false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => !(window.matchMedia?.('(max-width: 640px)').matches ?? false));
  const [panelTab, setPanelTab] = useState('tasks');
  const [collapsed, setCollapsed] = useState(false);
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

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 640px)');
    if (!query) return undefined;
    const update = (event) => {
      setMobile(event.matches);
      setNavigationOpen(false);
      setPanelOpen(!event.matches);
    };
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    if (!mobile || (!navigationOpen && !panelOpen)) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => (navigationOpen ? navigationDialogRef : panelDialogRef).current?.querySelector('button')?.focus());
    const close = (event) => {
      if (event.key !== 'Escape') return;
      if (navigationOpen) {
        setNavigationOpen(false);
        requestAnimationFrame(() => navigationButtonRef.current?.focus());
      } else {
        setPanelOpen(false);
        requestAnimationFrame(() => panelButtonRef.current?.focus());
      }
    };
    document.addEventListener('keydown', close);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', close);
    };
  }, [mobile, navigationOpen, panelOpen]);

  useEffect(() => { if (!selectedId && conversations[0]) setSelectedId(conversations[0].id); }, [conversations]);
  useEffect(() => {
    if (!selectedId || !supportsMethod(discovery, METHODS.markSidebarSeen)) return;
    globalClient.request(METHODS.markSidebarSeen, { conversationId: selectedId }).then(() => onRefresh()).catch(() => {});
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    initialScrollConversationId.current = selectedId;
    scrollRef.current?.style.removeProperty('--initial-scroll-clearance');
    setError('');
    const emptyState = recoverConversationState({});
    stateRef.current = emptyState;
    setState(emptyState);
    const socket = new RpcClient({ url: toWebSocketUrl(connection.serverUrl, conversationSocketPath(selectedId)), apiKey: connection.apiKey });
    let active = true;
    let recovering = false;
    let recoveryAttempt = 0;
    let recoveryTimer = null;
    let projectionTimer = null;
    let projectionRefreshing = false;
    let bufferedEvents = [];
    async function recover() {
      if (recovering) return;
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
      recovering = true;
      bufferedEvents = [];
      try {
        const context = await socket.request(METHODS.conversationContext, { limit: HISTORY_PAGE_SIZE });
        if (!active) return;
        const recovered = bufferedEvents.reduce(
          (current, notification) => applyConversationEvent(current, notification),
          recoverConversationState(context),
        );
        stateRef.current = recovered;
        setState(recovered);
        setHistory(normalizeMessagePage(context.messagePage ?? { messages: context.messages, hasMore: false }));
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
          recoveryTimer = setTimeout(recover, delay);
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
      if (event.detail.status !== 'online') setError(event.detail.error || 'Conversation connection is offline. Reconnecting...');
      else setError('');
    });
    socket.connect().then(() => { projectionTimer = setInterval(refreshProjection, 5_000); }).catch((value) => { if (active) setError(value.message); });
    setClient(socket);
    return () => { active = false; clearTimeout(recoveryTimer); clearInterval(projectionTimer); socket.close(); setClient(null); };
  }, [selectedId, connection.id]);

  useLayoutEffect(() => {
    const area = scrollRef.current;
    if (!area || initialScrollConversationId.current !== state.conversation?.id) return;
    const lastUserMessage = [...area.querySelectorAll('.message.user')].at(-1);
    if (lastUserMessage) {
      const top = area.scrollTop + lastUserMessage.getBoundingClientRect().top - area.getBoundingClientRect().top;
      const clearance = Math.max(0, top - Math.max(0, area.scrollHeight - area.clientHeight));
      area.style.setProperty('--initial-scroll-clearance', `${clearance}px`);
      area.scrollTo({ top });
    } else {
      area.scrollTo({ top: area.scrollHeight });
    }
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
    area.style.removeProperty('--initial-scroll-clearance');
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 160;
    if (!nearBottom) return undefined;
    const frame = requestAnimationFrame(() => area.scrollTo({ top: area.scrollHeight }));
    return () => cancelAnimationFrame(frame);
  }, [state.messages.length, state.messages.at(-1)?.content]);

  async function older() {
    const params = createOlderHistoryRequest(history);
    if (!params || !client) return;
    setLoadingOlder(true);
    try {
      const beforeHeight = scrollRef.current.scrollHeight;
      const page = normalizeMessagePage(await client.request(METHODS.conversationMessages, params));
      const next = { ...stateRef.current, messages: prependOlderMessages(stateRef.current.messages, page.messages) };
      stateRef.current = next;
      setState(next);
      setHistory(page);
      requestAnimationFrame(() => { scrollRef.current.scrollTop += scrollRef.current.scrollHeight - beforeHeight; });
    } catch (value) {
      if (!client.closed) setError(value.message);
    } finally { setLoadingOlder(false); }
  }
  function applyQueueResult(result) {
    const byId = new Map([...stateRef.current.queue.steer, ...stateRef.current.queue.queued, ...stateRef.current.messages].map((message) => [message.id, message]));
    const next = { ...stateRef.current, queue: {
      steer: (result?.steerMessageIds ?? result?.queueOrder?.steerMessageIds ?? []).map((id) => byId.get(id)).filter(Boolean),
      queued: (result?.queuedMessageIds ?? result?.queueOrder?.queuedMessageIds ?? []).map((id) => byId.get(id)).filter(Boolean),
    } };
    stateRef.current = next;
    setState(next);
  }
  async function createSideChat() {
    try {
      const result = await client.request(METHODS.createSideChat);
      if (result?.conversation?.id) selectConversation(result.conversation.id);
    } catch (value) { setError(value.message); }
  }
  async function createConversation(folder) {
    try {
      const item = await globalClient.request(METHODS.createConversation, conversationCreateParams(folder, models[0]?.id));
      await onRefresh(item);
      selectConversation(item.id);
    } catch (value) { setError(value.message); }
  }
  async function runSidebarAction(method, params, selectedConversationId = null) {
    try {
      const result = await globalClient.request(method, params);
      await onRefresh(result?.conversation ?? null);
      if (selectedConversationId) setSelectedId(selectedConversationId(result));
      return result;
    } catch (value) {
      setError(value.message);
      throw value;
    }
  }
  function selectConversation(id) {
    setSelectedId(id);
  }
  const sidebarProps = {
    bots: supportsMethod(discovery, METHODS.listBots) ? bots : undefined,
    connection,
    conversations,
    folders,
    models,
    schedulerSnooze,
    selectedId,
    sidebarStatus: supportsMethod(discovery, METHODS.sidebarStatus) ? sidebarStatus : undefined,
    tags: supportsMethod(discovery, METHODS.listTags) ? tags : undefined,
    onActivateBot: supportsMethod(discovery, METHODS.activateBot) ? (bot) => runSidebarAction(METHODS.activateBot, { payload: bot.id }) : undefined,
    onArchive: supportsMethod(discovery, METHODS.archiveConversation) ? (item) => runSidebarAction(METHODS.archiveConversation, { payload: item.id }) : undefined,
    onCreate: createConversation,
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
      chatArea.style.setProperty('--composer-clearance', `${Math.ceil(height)}px`);
    });
    observer.observe(composerWrap);
    return () => {
      observer.disconnect();
      chatArea.style.removeProperty('--composer-clearance');
    };
  }, [client, state.conversation?.id]);

  const visibleMessages = state.messages.filter((message) => !message.hidden && !['queued', 'steered'].includes(message.status));
  return <main class={`workspace ${collapsed ? 'sidebar-collapsed' : ''} ${panelOpen ? 'panel-open' : ''}`}>
    <p class="sr-only" role="status" aria-live="polite">{attentionCount ? `${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention.` : 'No items need attention.'}</p>
    <ConversationSidebar {...sidebarProps} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} />
    <section class="chat-area" ref={chatAreaRef}>
      <header class="mobile-header"><button ref={navigationButtonRef} aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><i class="ri-menu-line" /></button><div><strong>{conversationTitle}</strong><small>{conversationFolder}</small></div><button ref={panelButtonRef} aria-label="Open auxiliary panel" aria-haspopup="dialog" aria-expanded={panelOpen} onClick={() => setPanelOpen(true)}><i class="ri-layout-right-line" />{attentionCount > 0 && <b>{attentionCount}</b>}</button></header>
      <div class="conversation-scroll" ref={scrollRef} role="region" tabindex="0" aria-label="Conversation messages">{history.hasMore && <button class="load-older" disabled={loadingOlder} onClick={older}>{loadingOlder ? 'Loading...' : 'Load earlier messages'}</button>}{error && <p class="inline-error" role="alert">{error}</p>}{visibleMessages.length ? <div class="messages-column">{visibleMessages.map((message) => <RichMessage key={message.id} message={message} client={client} />)}</div> : <div class="empty-chat"><span class="avi-mark large">A</span><h1>{conversationTitle}</h1><p>Remote state stays authoritative on {connection.label}.</p></div>}</div>
      {client && state.conversation && <Composer client={client} state={state} models={models} messageDeliveryMode={messageDeliveryMode} onSent={onRefresh} onStop={() => client.request(METHODS.stop)} onSideChat={createSideChat} onOpenTasks={() => { setPanelTab('tasks'); setPanelOpen(true); }} onOpenAgents={() => { setPanelTab('agents'); setPanelOpen(true); }} onQueueOrder={applyQueueResult} onError={(value) => setError(value.message)} composerRef={composerWrapRef} />}
      {!mobile && !panelOpen && <button class="open-panel" aria-label="Open auxiliary panel" onClick={() => setPanelOpen(true)}><i class="ri-layout-right-line" /></button>}
    </section>
    {mobile && navigationOpen && <div ref={navigationDialogRef} class="mobile-drawer" role="dialog" aria-modal="true" aria-label="Navigation"><ConversationSidebar {...sidebarProps} collapsed={false} onClose={closeNavigation} /></div>}
    {mobile && navigationOpen && <button class="mobile-overlay-backdrop" aria-label="Close navigation" onClick={closeNavigation} />}
    {panelOpen && client && <AuxiliaryPanel modal={mobile} panelRef={panelDialogRef} tab={panelTab} state={state} client={client} onOpenConversation={selectConversation} onClose={closePanel} onTab={setPanelTab} onApprovalDone={(approvalId) => { const next = { ...stateRef.current, approvals: stateRef.current.approvals.filter((item) => item.approvalId !== approvalId) }; stateRef.current = next; setState(next); }} onQuestionDone={(questionId) => { const next = { ...stateRef.current, questions: stateRef.current.questions.filter((item) => item.questionId !== questionId) }; stateRef.current = next; setState(next); }} onQueueOrder={applyQueueResult} onSemaphoreDone={() => { const next = { ...stateRef.current, semaphoreWaits: [] }; stateRef.current = next; setState(next); }} onError={(value) => setError(value.message)} />}
    <div class="version-bar">Avi {discovery.appVersion} · Core v{discovery.versions.core} · MCP {discovery.versions.mcp.latest} · RPC v{discovery.apiVersion}</div>
  </main>;
}
