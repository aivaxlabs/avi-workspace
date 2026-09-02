import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { METHODS } from '../rpc/contracts.js';
import { moveQueueId, steerQueuedParams } from '../lib/queue-actions.js';

const BUILT_INS = [
  { name: 'stop', description: 'Stop the active run' },
  { name: 'side', description: 'Open a side chat' },
];
const PERMISSIONS = [
  { id: 'ask_for_approval', label: 'Ask for approval', description: 'Ask before every tool call', icon: 'ri-shield-keyhole-line' },
  { id: 'approve_for_me', label: 'Approve for me', description: 'Ask only before destructive actions', icon: 'ri-shield-check-line' },
  { id: 'full_access', label: 'Full access', description: 'Run tool calls without approval', icon: 'ri-shield-flash-line' },
];

export function Composer({ client, state, models, messageDeliveryMode = 'queue', onSent, onStop, onSideChat, onOpenTasks, onOpenAgents, onQueueOrder, onError, composerRef }) {
  const conversation = state.conversation;
  const snapshot = state.composer;
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('approve_for_me');
  const [workMode, setWorkMode] = useState(null);
  const [ultraMode, setUltraMode] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [options, setOptions] = useState([]);
  const [activeOption, setActiveOption] = useState(0);
  const [openMenu, setOpenMenu] = useState(null);
  const [modelSubmenu, setModelSubmenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const hydratedConversationId = useRef(null);
  const timer = useRef();
  const submitMode = useRef(null);
  const root = useRef();
  const modelHolderRef = useRef(null);
  const effortHolderRef = useRef(null);
  const modelSubmenuRef = useRef(null);
  const effortSubmenuRef = useRef(null);
  const invocation = useMemo(() => text.match(/(?:^|\s)([@/$])([^\s]*)$/), [text]);
  const selectedModel = models.find((item) => item.id === model);
  const permission = PERMISSIONS.find((item) => item.id === permissionMode) ?? PERMISSIONS[1];
  const contextPercent = state.contextUsage.limit
    ? Math.min(100, Math.round((state.contextUsage.tokens / state.contextUsage.limit) * 100))
    : null;
  const editStats = useMemo(() => {
    const lastUser = state.messages.findLastIndex((message) => message.role === 'user' && !message.hidden);
    const edits = new Map();
    for (const message of state.messages.slice(lastUser + 1)) {
      if (message.hidden) continue;
      for (const edit of message.edits ?? []) {
        if (typeof edit?.filePath !== 'string' || typeof edit.after !== 'string') continue;
        const current = edits.get(edit.filePath);
        edits.set(edit.filePath, current ? { ...current, after: edit.after } : edit);
      }
    }
    return [...edits.values()].reduce((result, edit) => {
      const before = edit.before === null || edit.before === '' ? [] : String(edit.before).split(/\r?\n/);
      const after = edit.after === '' ? [] : edit.after.split(/\r?\n/);
      let start = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
      let beforeEnd = before.length;
      let afterEnd = after.length;
      while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd -= 1; afterEnd -= 1; }
      if (beforeEnd === start && afterEnd === start) return result;
      return { files: result.files + 1, additions: result.additions + afterEnd - start, deletions: result.deletions + beforeEnd - start };
    }, { files: 0, additions: 0, deletions: 0 });
  }, [state.messages]);
  const agents = [...state.subagents, ...state.rubberDucks];
  const agentCounts = agents.reduce((counts, item) => {
    const status = item.workStatus ?? item.status;
    if (['working', 'waiting', 'sleeping'].includes(status)) counts.working += 1;
    else if (status === 'failed') counts.failed += 1;
    else counts.finished += 1;
    return counts;
  }, { working: 0, finished: 0, failed: 0 });

  useEffect(() => {
    if (!conversation?.id || hydratedConversationId.current === conversation.id) return;
    hydratedConversationId.current = conversation.id;
    setHydrated(false);
    const draft = snapshot ?? {};
    const nextModel = draft.model || conversation.model || models[0]?.id || '';
    const efforts = models.find((item) => item.id === nextModel)?.reasoning ?? [];
    setText(draft.draftText ?? '');
    setAttachments(draft.attachments ?? []);
    setPermissionMode(draft.permissionMode ?? 'approve_for_me');
    setModel(nextModel);
    setReasoningEffort(efforts.includes(draft.reasoningEffort) ? draft.reasoningEffort : efforts[0] ?? '');
    setWorkMode(draft.workMode ?? (conversation.orchestrationMode === 'plan' ? 'plan' : null));
    setUltraMode(Boolean(draft.ultraMode ?? conversation.orchestrationMode === 'ultra'));
    setHydrated(true);
  }, [conversation?.id, snapshot, models]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const save = setTimeout(() => client.request(METHODS.composerSave, {
      permissionMode, model, reasoningEffort: reasoningEffort || null, workMode, ultraMode,
      draftText: text, attachments,
    }).catch(() => {}), 300);
    return () => clearTimeout(save);
  }, [attachments, client, hydrated, model, permissionMode, reasoningEffort, text, ultraMode, workMode]);

  useEffect(() => {
    const close = (event) => {
      if (root.current?.contains(event.target)) return;
      setOpenMenu(null);
      setModelSubmenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  useEffect(() => {
    if (!modelSubmenu) return undefined;
    const holder = modelSubmenu === 'model' ? modelHolderRef.current : effortHolderRef.current;
    const submenu = modelSubmenu === 'model' ? modelSubmenuRef.current : effortSubmenuRef.current;
    if (!holder || !submenu) return undefined;
    const position = () => {
      const holderRect = holder.getBoundingClientRect();
      const width = submenu.offsetWidth;
      const height = submenu.offsetHeight;
      const margin = 8;
      const gap = 6;
      let left = holderRect.left - gap - width;
      if (left < margin) left = Math.min(holderRect.right + gap, window.innerWidth - width - margin);
      let top = holderRect.top;
      if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
      submenu.style.right = 'auto';
      submenu.style.left = `${left - holderRect.left}px`;
      submenu.style.top = `${top - holderRect.top}px`;
    };
    const frame = window.requestAnimationFrame(position);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [modelSubmenu]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!invocation) { setOptions([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const query = invocation[2];
        const remote = invocation[1] === '@'
          ? ((await client.request(METHODS.mentions, { query })).paths ?? []).map((item) => ({ ...item, label: item.label ?? item.path, value: item.path }))
          : (await client.request(METHODS.commands)).filter((item) => item.type === (invocation[1] === '$' ? 'skill' : 'workflow') && (!query || item.name.toLowerCase().includes(query.toLowerCase()))).map((item) => ({ ...item, label: `${invocation[1]}${item.name}`, value: `${invocation[1]}${item.name}` }));
        setOptions(invocation[1] === '/' ? [...BUILT_INS.map((item) => ({ ...item, label: `/${item.name}`, value: `/${item.name}` })), ...remote] : remote);
        setActiveOption(0);
      } catch { setOptions([]); }
    }, 120);
    return () => clearTimeout(timer.current);
  }, [invocation?.[0], invocation?.[2], client]);

  useEffect(() => {
    if (!options.length) return;
    document.getElementById(`composer-option-${activeOption}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeOption, options]);

  function choose(option) {
    if (option.name && BUILT_INS.some((item) => item.name === option.name)) {
      setText(text.slice(0, text.length - invocation[0].trimStart().length) + option.value + ' ');
      setOptions([]);
      return;
    }
    const prefix = invocation[1];
    const markerType = prefix === '$' ? 'skill' : prefix === '/' ? 'workflow' : option.type === 'directory' || option.kind === 'directory' ? 'directory_reference' : 'file_reference';
    const markerKey = option.path ?? option.name;
    setAttachments((current) => current.some((item) => item.markerType === markerType && item.markerKey === markerKey) ? current : [...current, {
      id: crypto.randomUUID(), kind: 'context_marker', markerType, markerKey,
      ...(prefix === '@' ? { path: option.path } : { commandName: option.name }),
      name: option.label, size: 0,
      text: prefix === '@' ? `The user mentioned workspace ${markerType === 'directory_reference' ? 'directory' : 'file'} “${option.path}”. Inspect it when relevant.` : `Use the ${option.name} ${markerType}.`,
    }]);
    setText(text.slice(0, text.length - invocation[0].trimStart().length));
    setOptions([]);
  }

  async function mutateQueue(method, payload) {
    try { onQueueOrder(await client.request(method, payload)); } catch (error) { onError(error); }
  }

  function reorderQueue(items, queueType, index, direction) {
    const moved = moveQueueId(items.map((item) => item.id), index, direction);
    if (moved) mutateQueue(METHODS.reorderQueued, { queueType, messageIds: moved });
  }

  async function submit(event) {
    event.preventDefault();
    const activeSendMode = submitMode.current ?? messageDeliveryMode;
    submitMode.current = null;
    if ((!text.trim() && attachments.length === 0) || !model || busy) return;
    if (text.trim() === '/stop') return onStop().catch(onError);
    if (text.trim() === '/side') return onSideChat();
    setBusy(true);
    try {
      const goalContinues = conversation.goal && ['active', 'paused'].includes(conversation.goal.status);
      if (workMode === 'goal' && !goalContinues) {
        await client.request(METHODS.startGoal, { specification: text.trim(), model, reasoningEffort: reasoningEffort || null, attachments, permissionMode, ultraMode });
      } else {
        await client.request(METHODS.send, { text: text.trim(), model, reasoningEffort: reasoningEffort || null, attachments, permissionMode, workMode, ultraMode, steer: state.run.active && activeSendMode === 'steer' });
      }
      setText('');
      setAttachments([]);
      onSent();
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  }

  const visibleOptions = options.slice(0, 12);
  const queueSections = [
    { id: 'steer', label: 'Steer', description: 'Applied after the current assistant turn', icon: 'ri-corner-down-left-line', items: state.queue.steer },
    { id: 'queue', label: 'Queue', description: 'Sent after the assistant finishes', icon: 'ri-time-line', items: state.queue.queued },
  ].filter((section) => section.items.length);
  return <section class="composer-wrap" ref={(element) => { root.current = element; if (composerRef) composerRef.current = element; }}>
    {editStats.files > 0 && <div class="composer-edit-pill" role="status"><i class="ri-file-edit-line" /><span>{editStats.files} {editStats.files === 1 ? 'file' : 'files'}</span><b>+{editStats.additions}</b><em>-{editStats.deletions}</em></div>}
    <div class="composer-strips">
      {state.tasks.length > 0 && <button type="button" class="composer-strip" onClick={onOpenTasks}><i class="ri-list-check-3" /><span>{state.tasks.filter((task) => task.done).length}/{state.tasks.length} tasks completed</span><i class="ri-arrow-right-s-line" /></button>}
      {agents.length > 0 && <button type="button" class="composer-strip" onClick={onOpenAgents}><i class="ri-node-tree" /><span>{agentCounts.working} sub-agents working, {agentCounts.finished} finished{agentCounts.failed ? `, ${agentCounts.failed} failed` : ''}</span><i class="ri-arrow-right-s-line" /></button>}
      <div class="composer-queues">
        {queueSections.map((section) => <section class={`composer-strip queue-strip ${section.id}-queue-strip`} aria-label={`${section.label} messages`} key={section.id}>
          <header class="queue-strip-header">
            <span class="queue-strip-title"><i class={section.icon} /><strong>{section.label}</strong><span>{section.items.length}</span></span>
            <small>{section.description}</small>
          </header>
          <ol class="queue-list">{section.items.map((message, index) => <li key={message.id}>
            <span class="queue-position">{index + 1}</span>
            <p title={message.content || message.attachments?.map((item) => item.name).join(', ')}>{message.content || message.attachments?.map((item) => item.name).join(', ') || 'Message with attachments'}</p>
            <div class="queue-actions">
              <button type="button" title="Move up" aria-label={`Move ${section.label.toLowerCase()} message up`} disabled={index === 0} onClick={() => reorderQueue(section.items, section.id, index, -1)}><i class="ri-arrow-up-line" /></button>
              <button type="button" title="Move down" aria-label={`Move ${section.label.toLowerCase()} message down`} disabled={index === section.items.length - 1} onClick={() => reorderQueue(section.items, section.id, index, 1)}><i class="ri-arrow-down-line" /></button>
              {section.id === 'queue' && <button type="button" class="queue-steer" title="Prioritize after the current assistant turn" aria-label="Steer queued message" onClick={() => mutateQueue(METHODS.reorderQueued, steerQueuedParams(section.items, message.id))}><i class="ri-corner-down-left-line" /><span>Steer</span></button>}
              <button type="button" class="queue-remove" title={`Remove from ${section.label.toLowerCase()}`} aria-label="Cancel queued message" onClick={() => mutateQueue(METHODS.cancelQueued, { messageId: message.id })}><i class="ri-delete-bin-line" /></button>
            </div>
          </li>)}</ol>
        </section>)}
      </div>
    </div>
    <form class="composer" onSubmit={submit}>
      {visibleOptions.length > 0 && <div id="composer-suggestions" class="command-picker" role="listbox" aria-label="Composer suggestions">{visibleOptions.map((option, index) => <button key={`${option.value}-${index}`} id={`composer-option-${index}`} type="button" role="option" aria-selected={index === activeOption} tabIndex={-1} onMouseEnter={() => setActiveOption(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}><strong>{option.label}</strong><small>{option.description ?? option.type}</small></button>)}</div>}
      {attachments.length > 0 && <div class="composer-markers">{attachments.map((attachment) => <span key={attachment.id}><i class={attachment.markerType === 'skill' ? 'ri-sparkling-line' : attachment.markerType === 'workflow' ? 'ri-flow-chart' : 'ri-file-line'} /><span>{attachment.name}</span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><i class="ri-close-line" /></button></span>)}</div>}
      <textarea role="combobox" aria-label="Message Avi" aria-autocomplete="list" aria-haspopup="listbox" aria-controls={visibleOptions.length ? 'composer-suggestions' : undefined} aria-expanded={visibleOptions.length > 0} aria-activedescendant={visibleOptions.length ? `composer-option-${activeOption}` : undefined} placeholder={workMode === 'goal' ? 'Describe the Goal...' : workMode === 'plan' ? 'Describe your task to generate a plan...' : ultraMode ? 'Describe the objective for the Ultra team...' : 'Message Avi...  @ files  $ skills  / commands'} value={text} onInput={(event) => setText(event.currentTarget.value)} onKeyDown={(event) => {
        if (event.isComposing) return;
        if (visibleOptions.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setActiveOption((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + visibleOptions.length) % visibleOptions.length); }
        else if (visibleOptions.length && ['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); choose(visibleOptions[activeOption]); }
        else if (visibleOptions.length && event.key === 'Escape') { event.preventDefault(); setOptions([]); setActiveOption(0); }
        else if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitMode.current = event.ctrlKey ? (messageDeliveryMode === 'steer' ? 'queue' : 'steer') : messageDeliveryMode;
          event.currentTarget.form.requestSubmit();
        }
      }} />
      <footer>
        <div class="composer-controls">
          <div class="composer-menu-holder"><button type="button" class="round-control" aria-label="Composer actions" aria-haspopup="menu" aria-expanded={openMenu === 'plus'} onClick={() => setOpenMenu(openMenu === 'plus' ? null : 'plus')}><i class="ri-add-line" /></button>{openMenu === 'plus' && <div class="composer-menu plus-menu" role="menu"><button type="button" role="menuitemcheckbox" aria-checked={ultraMode} onClick={() => { setUltraMode(!ultraMode); setWorkMode(null); setOpenMenu(null); }}><i class="ri-flashlight-line" />Ultra</button><button type="button" role="menuitemcheckbox" aria-checked={workMode === 'goal'} onClick={() => { setWorkMode(workMode === 'goal' ? null : 'goal'); setUltraMode(false); setOpenMenu(null); }}><i class="ri-focus-3-line" />Goal</button><button type="button" role="menuitemcheckbox" aria-checked={workMode === 'plan'} onClick={() => { setWorkMode(workMode === 'plan' ? null : 'plan'); setUltraMode(false); setOpenMenu(null); }}><i class="ri-list-check-3" />Plan</button><button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onSideChat(); }}><i class="ri-chat-new-line" />Side chat</button><span class="mobile-permission-label">Permission</span><div class="mobile-permission-options">{PERMISSIONS.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === permissionMode} onClick={() => { setPermissionMode(item.id); setOpenMenu(null); }}><i class={item.icon} /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>)}</div></div>}</div>
          <div class="composer-menu-holder permission-control"><button type="button" class="control-chip" aria-haspopup="menu" aria-expanded={openMenu === 'permission'} onClick={() => setOpenMenu(openMenu === 'permission' ? null : 'permission')}><i class={permission.icon} /><span>{permission.label}</span><i class="ri-arrow-down-s-line" /></button>{openMenu === 'permission' && <div class="composer-menu permission-menu" role="menu">{PERMISSIONS.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === permissionMode} onClick={() => { setPermissionMode(item.id); setOpenMenu(null); }}><i class={item.icon} /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>)}</div>}</div>
          {workMode && <button type="button" class="mode-chip" onClick={() => setWorkMode(null)}><i class={workMode === 'goal' ? 'ri-focus-3-line' : 'ri-list-check-3'} />{workMode === 'goal' ? 'Goal' : 'Plan'}<i class="ri-close-line" /></button>}
          {ultraMode && <button type="button" class="mode-chip" onClick={() => setUltraMode(false)}><i class="ri-flashlight-line" />Ultra<i class="ri-close-line" /></button>}
        </div>
        <div class="composer-submit-row">
          <div class="composer-menu-holder model-menu-holder">
            <button type="button" class="model-chip" aria-haspopup="menu" aria-expanded={openMenu === 'model'} onClick={() => { setOpenMenu(openMenu === 'model' ? null : 'model'); setModelSubmenu(null); }}><span>{selectedModel?.name ?? model}</span>{reasoningEffort && <small> - {reasoningEffort}</small>}<i class="ri-arrow-down-s-line" /></button>
            {openMenu === 'model' && <div class="composer-menu model-menu" role="menu" aria-label="Advanced model settings" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setOpenMenu(null); setModelSubmenu(null); } }}>
              <header class="advanced-menu-header"><span>Advanced</span><i class="ri-arrow-down-s-line" /></header>
              <div ref={modelHolderRef} class="model-submenu-holder" onMouseEnter={() => setModelSubmenu('model')} onMouseLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setModelSubmenu(null); }} onFocus={() => setModelSubmenu('model')} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setModelSubmenu(null); }} onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); setModelSubmenu('model'); queueMicrotask(() => event.currentTarget.querySelector('.model-reasoning-submenu button')?.focus()); } else if (event.key === 'ArrowLeft') { event.preventDefault(); setModelSubmenu(null); event.currentTarget.querySelector('.model-reasoning-trigger')?.focus(); } }}>
                <button type="button" class="model-reasoning-trigger" role="menuitem" aria-label="Choose model" aria-haspopup="menu" aria-expanded={modelSubmenu === 'model'} onClick={() => setModelSubmenu(modelSubmenu === 'model' ? null : 'model')}><span>Model</span><span>{selectedModel?.name ?? model}<i class="ri-arrow-right-s-line" /></span></button>
                {modelSubmenu === 'model' && <div ref={modelSubmenuRef} class="composer-menu model-reasoning-submenu" role="menu" aria-label="Models">{models.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === model} onClick={() => { setModel(item.id); setReasoningEffort(item.reasoning?.includes('medium') ? 'medium' : item.reasoning?.[0] ?? ''); setOpenMenu(null); setModelSubmenu(null); }}><span>{item.name ?? item.id}</span>{item.id === model && <i class="ri-check-line" />}</button>)}</div>}
              </div>
              {selectedModel?.reasoning?.length > 0 && <div ref={effortHolderRef} class="model-submenu-holder" onMouseEnter={() => setModelSubmenu('effort')} onMouseLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setModelSubmenu(null); }} onFocus={() => setModelSubmenu('effort')} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setModelSubmenu(null); }} onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); setModelSubmenu('effort'); queueMicrotask(() => event.currentTarget.querySelector('.model-reasoning-submenu button')?.focus()); } else if (event.key === 'ArrowLeft') { event.preventDefault(); setModelSubmenu(null); event.currentTarget.querySelector('.model-reasoning-trigger')?.focus(); } }}>
                <button type="button" class="model-reasoning-trigger effort-trigger" role="menuitem" aria-label="Choose effort" aria-haspopup="menu" aria-expanded={modelSubmenu === 'effort'} onClick={() => setModelSubmenu(modelSubmenu === 'effort' ? null : 'effort')}><span>Effort</span><span>{reasoningEffort || 'Default'}<i class="ri-arrow-right-s-line" /></span></button>
                {modelSubmenu === 'effort' && <div ref={effortSubmenuRef} class="composer-menu model-reasoning-submenu effort-submenu" role="menu" aria-label="Reasoning effort">{selectedModel.reasoning.map((effort) => <button key={effort} type="button" role="menuitemradio" aria-checked={effort === reasoningEffort} onClick={() => { setReasoningEffort(effort); setOpenMenu(null); setModelSubmenu(null); }}><span>{effort}</span>{effort === reasoningEffort && <i class="ri-check-line" />}</button>)}</div>}
              </div>}
            </div>}
          </div>
          {state.run.active ? <button type="button" class="send" aria-label="Stop" onClick={onStop}><i class="ri-stop-fill" /></button> : <button type="submit" class="send" aria-label="Send" disabled={busy || (!text.trim() && attachments.length === 0) || !model}><i class="ri-arrow-up-line" /></button>}
        </div>
      </footer>
    </form>
    <div class="composer-meta"><span title={conversation.projectPath}><i class="ri-folder-line" />{conversation.projectDisplayPath ?? conversation.projectPath}</span>{conversation.gitBranch && <span><i class="ri-git-branch-line" />{conversation.gitBranch}<i class="ri-lock-line" /></span>}<span class="context-indicator" title={state.contextUsage.limit ? `${state.contextUsage.tokens.toLocaleString()} of ${state.contextUsage.limit.toLocaleString()} input tokens used` : 'Context limit unavailable'}><i class="ri-speed-up-line" />{contextPercent === null ? '—' : `${contextPercent}%`}</span></div>
  </section>;
}
