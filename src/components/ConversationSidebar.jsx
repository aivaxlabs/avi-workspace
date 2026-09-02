import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildFolderNavigation, FOLDER_GROUP_LIMIT, folderDisplayName } from '../lib/conversation-folders.js';
import {
  deriveBotStatus,
  deriveConversationStatus,
  deriveTagFilters,
  deriveTaskGroups,
  filterSidebarConversations,
  normalizeSidebarSnapshot,
} from '../lib/sidebar-state.js';
import { SidebarBotDialog, SidebarSearchDialog, SidebarTagsDialog } from './SidebarDialogs.jsx';

const STATUS_ICONS = Object.freeze({
  approval: 'ri-shield-keyhole-line',
  input: 'ri-question-answer-line',
  semaphore: 'ri-hourglass-2-line',
  working: 'ri-loader-4-line',
  blocked: 'ri-error-warning-line',
  attention: 'ri-flag-line',
  completed: 'ri-check-double-line',
  idle: 'ri-chat-3-line',
});

const SNOOZE_PRESETS = Object.freeze([
  { label: 'Snooze for 1h', options: { durationMinutes: 60 } },
  { label: 'Snooze for 6h', options: { durationMinutes: 360 } },
  { label: 'Snooze for 24h', options: { durationMinutes: 1440 } },
  { label: 'Snooze until restart', options: { untilRestart: true } },
]);

const FOLDER_COLORS = Object.freeze(['#8aa7ff', '#66c58a', '#e0aa61', '#ee7d7d', '#c58ae0', '#5fc8c0', '#e0d361', '#8a8f99']);

function snoozeRemainingText(snooze) {
  if (!snooze?.active) return null;
  if (snooze.mode === 'until-restart') return 'until restart';
  const until = new Date(snooze.until ?? '').getTime();
  if (!Number.isFinite(until)) return null;
  const minutes = Math.ceil((until - Date.now()) / 60_000);
  if (minutes <= 0) return null;
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d` : minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
}

function MenuItem({ icon, color, checked, danger, children, ...rest }) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      class={`menu-item${danger ? ' danger' : ''}${checked ? ' checked' : ''}`}
      {...rest}
    >
      {color
        ? <span class="tag-dot" style={{ background: color }} aria-hidden="true" />
        : <i class={icon} aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}

function MenuDivider() {
  return <hr class="menu-divider" />;
}

function ThreadRow({ item, selected, status, folderLabel, folderTitle, tagDots, menuOpen, onToggleMenu, onSelect, onClose }) {
  return (
    <li class={`${selected ? 'active' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <button
        type="button"
        class="thread-open"
        aria-label={`${item.title || 'New chat'}${status.state !== 'idle' ? ` — ${status.label}` : ''}`}
        aria-current={selected ? 'page' : undefined}
        onClick={() => { onSelect(item.id); onClose?.(); }}
      >
        <i class={`thread-status ${status.state} ${STATUS_ICONS[status.state]}${status.state === 'working' ? ' spinning' : ''}`} title={status.label} aria-label={status.label} />
        <span>
          <strong>
            {item.title || 'New chat'}
            {item.createdBy === 'agent' && <i class="ri-robot-2-line agent-thread-icon" title="Created by an agent" aria-label="Created by an agent" />}
            {tagDots.length > 0 && <span class="row-tag-dots">{tagDots}</span>}
          </strong>
          <small title={folderTitle}>{folderLabel}</small>
        </span>
      </button>
      <button
        type="button"
        class="thread-menu"
        aria-label={`Actions for ${item.title || 'New chat'}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onToggleMenu}
      ><i class="ri-more-2-line" /></button>
    </li>
  );
}

export function ConversationSidebar({
  collapsed, connection, conversations = [], folders = [], models = [], bots, tags,
  sidebarStatus, schedulerSnooze, selectedId,
  onClose, onCollapse, onCreate, onExit, onSelect,
  onRename, onSearch, onArchive, onDelete, onFork, onSetConversationTags,
  onSaveTags, onSaveFolderColor,
  onActivateBot, onSnoozeBot, onSnoozeBots, onCreateBot, onUpdateBot, onDeleteBot,
}) {
  const [menu, setMenu] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const [openGroups, setOpenGroups] = useState({});
  const [expandedGroups, setExpandedGroups] = useState({});
  const [showAgentCreated, setShowAgentCreated] = useState(false);
  const [activeTagIds, setActiveTagIds] = useState(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false);
  const [botDialog, setBotDialog] = useState(null);
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const { anchor } = menu;
    let frame;
    const reposition = (focus = false) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const popover = popoverRef.current;
        if (!anchor.isConnected || !popover) {
          setMenu(null);
          return;
        }
        const anchorRect = anchor.getBoundingClientRect();
        const margin = 8;
        const gap = 6;
        const width = popover.offsetWidth || 220;
        const height = popover.offsetHeight || 0;
        setMenuPosition({
          left: Math.min(Math.max(margin, anchorRect.right - width), Math.max(margin, window.innerWidth - width - margin)),
          top: anchorRect.bottom + gap + height <= window.innerHeight - margin
            ? anchorRect.bottom + gap
            : Math.max(margin, anchorRect.top - height - gap),
        });
        if (focus) popover.querySelector('[role^="menuitem"]')?.focus();
      });
    };
    reposition(true);
    const scheduleReposition = () => reposition();
    const dismiss = (event) => {
      if (!popoverRef.current?.contains(event.target) && !anchor.contains(event.target)) setMenu(null);
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setMenu(null);
      anchor.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('scroll', scheduleReposition, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', scheduleReposition);
      window.removeEventListener('scroll', scheduleReposition, true);
    };
  }, [menu]);

  const filters = useMemo(() => ({ activeTagIds, showAgentCreatedThreads: showAgentCreated }), [activeTagIds, showAgentCreated]);
  const snapshot = useMemo(() => normalizeSidebarSnapshot(sidebarStatus), [sidebarStatus]);
  const visibleConversations = useMemo(() => filterSidebarConversations(conversations, filters), [conversations, filters]);
  const navigation = useMemo(() => buildFolderNavigation(folders, visibleConversations), [folders, visibleConversations]);
  const taskGroups = useMemo(() => deriveTaskGroups(visibleConversations, snapshot, filters), [visibleConversations, snapshot, filters]);
  const tagFilters = useMemo(() => deriveTagFilters(tags, activeTagIds), [tags, activeTagIds]);
  const tagById = useMemo(() => new Map((Array.isArray(tags) ? tags : []).map((tag) => [tag.id, tag])), [tags]);
  const botsWithStatus = useMemo(() => (Array.isArray(bots) ? bots : []).map((bot) => ({ ...bot, status: deriveBotStatus(bot) })), [bots]);
  const snoozeRemaining = snoozeRemainingText(schedulerSnooze);
  const hasTaskGroups = taskGroups.working.length > 0 || taskGroups.review.length > 0;
  const filterActive = showAgentCreated || activeTagIds.size > 0;

  function toggleTagFilter(tagId) {
    setActiveTagIds((current) => {
      const next = new Set(current);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  function toggleConversationTag(item, tagId) {
    if (!onSetConversationTags) return;
    const current = item.tags ?? [];
    const next = current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId];
    onSetConversationTags(item, next);
  }

  function renameItem(item) {
    const title = window.prompt('Rename conversation', item.title);
    if (!title?.trim() || title.trim() === item.title) return;
    onRename?.(item, title.trim());
  }

  function deleteItem(item) {
    if (window.confirm(`Delete chat "${item.title || 'New chat'}"? This cannot be undone.`)) onDelete?.(item);
  }

  function deleteBot(bot) {
    if (window.confirm(`Delete bot "${bot.name}"? This cannot be undone.`)) onDeleteBot?.(bot);
  }

  function copyItemId(item) {
    globalThis.navigator?.clipboard?.writeText(item.id)?.catch?.(() => {});
  }

  function toggleExpanded(key) {
    setExpandedGroups((current) => ({ ...current, [key]: !current[key] }));
  }

  function toggleMenu(kind, id, anchor, data) {
    setMenuPosition(null);
    setMenu((current) => current?.kind === kind && current.id === id && current.anchor === anchor
      ? null
      : { kind, id, anchor, data });
  }

  function tagDotsFor(item) {
    return (item.tags ?? []).map((tagId) => tagById.get(tagId)).filter(Boolean).map((tag) => (
      <i key={tag.id} class="tag-dot" style={{ background: tag.color }} title={tag.name} aria-label={tag.name} />
    ));
  }

  function renderThreadRow(item, folderLabel, folderTitle, rowKey) {
    return (
      <ThreadRow
        key={item.id}
        item={item}
        selected={item.id === selectedId}
        status={deriveConversationStatus(item, snapshot)}
        folderLabel={folderLabel}
        folderTitle={folderTitle}
        tagDots={tagDotsFor(item)}
        menuOpen={menu?.kind === 'thread' && menu.id === rowKey}
        onToggleMenu={(event) => toggleMenu('thread', rowKey, event.currentTarget, item)}
        onSelect={onSelect}
        onClose={onClose}
      />
    );
  }

  function taskGroupSection(title, key, items, spin) {
    const expanded = Boolean(expandedGroups[key]);
    const visibleItems = expanded ? items : items.slice(0, FOLDER_GROUP_LIMIT);
    return (
      <section class={`task-group ${spin ? 'working-group' : 'review-group'}`} key={key}>
        <div class="task-group-label">
          <i class={spin ? 'ri-loader-4-line spinning' : 'ri-check-double-line'} aria-hidden="true" />
          <span>{title}</span>
          <b>{items.length}</b>
        </div>
        <ul class="thread-list compact">
          {visibleItems.map((item) => {
            const folderPath = item.projectDisplayPath ?? item.projectPath ?? item.projectName ?? '';
            return renderThreadRow(item, folderDisplayName(folderPath, item.projectName ?? folderPath), folderPath, `${key}:${item.id}`);
          })}
        </ul>
        {items.length > FOLDER_GROUP_LIMIT && (
          <button type="button" class="show-more" aria-expanded={expanded} onClick={() => toggleExpanded(key)}>
            <span>{expanded ? 'Show less' : `Show ${items.length - FOLDER_GROUP_LIMIT} more`}</span>
            <i class={expanded ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line'} aria-hidden="true" />
          </button>
        )}
      </section>
    );
  }

  let menuClass = 'sidebar-menu';
  let menuLabel = '';
  let menuContent = null;
  if (menu?.kind === 'picker') {
    menuClass = 'folder-picker';
    menuLabel = 'Choose working folder';
    menuContent = (
      <>
        <strong>Choose working folder</strong>
        {navigation.choices.map((folder) => <button key={folder.key} type="button" role="menuitem" onClick={() => { setMenu(null); onCreate(folder); onClose?.(); }}><i class={folder.isHome ? 'ri-home-4-line' : 'ri-folder-line'} /><span><b>{folder.label}</b><small>{folder.displayPath}</small></span></button>)}
      </>
    );
  } else if (menu?.kind === 'snooze') {
    menuLabel = 'Snooze bot activations';
    menuContent = (
      <>
        {SNOOZE_PRESETS.map((preset) => (
          <MenuItem key={preset.label} icon="ri-time-line" onClick={() => { setMenu(null); onSnoozeBots(preset.options); }}>{preset.label}</MenuItem>
        ))}
        {schedulerSnooze?.active && snoozeRemaining && (
          <>
            <MenuDivider />
            <MenuItem icon="ri-close-circle-line" onClick={() => { setMenu(null); onSnoozeBots({ reset: true }); }}>Reset ({snoozeRemaining})</MenuItem>
          </>
        )}
      </>
    );
  } else if (menu?.kind === 'bot') {
    const bot = menu.data;
    menuLabel = `Actions for ${bot.name}`;
    menuContent = (
      <>
        {onUpdateBot && <MenuItem icon="ri-pencil-line" onClick={() => { setMenu(null); setBotDialog({ bot }); }}>Edit...</MenuItem>}
        {onActivateBot && <MenuItem icon="ri-play-circle-line" disabled={bot.enabled === false} onClick={() => { setMenu(null); onActivateBot(bot); }}>Activate now</MenuItem>}
        {onSnoozeBot && (
          <>
            <MenuItem icon="ri-time-line" onClick={() => { setMenu(null); onSnoozeBot(bot, { durationMinutes: 60 }); }}>Snooze for 1h</MenuItem>
            <MenuItem icon="ri-time-line" onClick={() => { setMenu(null); onSnoozeBot(bot, { durationMinutes: 1440 }); }}>Snooze for 24h</MenuItem>
            {bot.snooze?.active && <MenuItem icon="ri-close-circle-line" onClick={() => { setMenu(null); onSnoozeBot(bot, { reset: true }); }}>Reset snooze</MenuItem>}
          </>
        )}
        {onDeleteBot && (
          <>
            <MenuDivider />
            <MenuItem icon="ri-delete-bin-line" danger onClick={() => { setMenu(null); deleteBot(bot); }}>Delete bot</MenuItem>
          </>
        )}
      </>
    );
  } else if (menu?.kind === 'filter') {
    menuLabel = 'Filter conversations';
    menuContent = (
      <>
        <MenuItem checked={showAgentCreated} icon="ri-robot-2-line" onClick={() => setShowAgentCreated(!showAgentCreated)}>Show agent-created threads</MenuItem>
        {tagFilters.length > 0 && (
          <>
            <MenuDivider />
            <div class="menu-label">Filter by tags</div>
            {tagFilters.map((tag) => (
              <MenuItem key={tag.id} checked={tag.active} color={tag.color} onClick={() => toggleTagFilter(tag.id)}>{tag.name}</MenuItem>
            ))}
          </>
        )}
        {onSaveTags && (
          <>
            <MenuDivider />
            <MenuItem icon="ri-settings-3-line" onClick={() => { setMenu(null); setTagsDialogOpen(true); }}>Manage tags...</MenuItem>
          </>
        )}
      </>
    );
  } else if (menu?.kind === 'thread') {
    const item = menu.data;
    const itemTagIds = item.tags ?? [];
    menuClass += ' conversation-menu';
    menuLabel = `Actions for ${item.title || 'New chat'}`;
    menuContent = (
      <>
        {onRename && <MenuItem icon="ri-pencil-line" onClick={() => { setMenu(null); renameItem(item); }}>Rename</MenuItem>}
        {onFork && <MenuItem icon="ri-git-branch-line" onClick={() => { setMenu(null); onFork(item); }}>Fork chat</MenuItem>}
        <MenuItem icon="ri-hashtag" onClick={() => { setMenu(null); copyItemId(item); }}>Copy thread ID</MenuItem>
        <MenuDivider />
        {onSetConversationTags && (tagFilters.length > 0
          ? tagFilters.map((tag) => (
            <MenuItem key={tag.id} checked={itemTagIds.includes(tag.id)} color={tag.color} onClick={() => toggleConversationTag(item, tag.id)}>{tag.name}</MenuItem>
          ))
          : <div class="menu-empty">No tags yet</div>)}
        {onSaveTags && <MenuItem icon="ri-settings-3-line" onClick={() => { setMenu(null); setTagsDialogOpen(true); }}>Manage tags...</MenuItem>}
        {(onArchive || onDelete) && <MenuDivider />}
        {onArchive && <MenuItem icon="ri-archive-line" onClick={() => { setMenu(null); onArchive(item); }}>Archive chat</MenuItem>}
        {onDelete && <MenuItem icon="ri-delete-bin-line" danger onClick={() => { setMenu(null); deleteItem(item); }}>Delete chat</MenuItem>}
      </>
    );
  } else if (menu?.kind === 'color') {
    const group = menu.data;
    menuClass += ' color-menu';
    menuLabel = `Folder color for ${group.label}`;
    menuContent = (
      <>
        <div class="palette-row" role="group" aria-label="Folder colors">
          {FOLDER_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={group.color === color}
              aria-label={`Set folder color ${color}`}
              class={`color-swatch${group.color === color ? ' active' : ''}`}
              style={{ background: color }}
              onClick={() => { setMenu(null); onSaveFolderColor(group, color); }}
            />
          ))}
        </div>
        <MenuItem icon="ri-close-circle-line" onClick={() => { setMenu(null); onSaveFolderColor(group, null); }}>No color</MenuItem>
      </>
    );
  }

  return (
    <aside class="sidebar">
      <header>
        <span class="avi-mark">A</span>
        <button aria-label={onClose ? 'Close navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onClose ?? onCollapse}><i class={onClose ? 'ri-close-line' : collapsed ? 'ri-layout-left-line' : 'ri-side-bar-line'} /></button>
      </header>
      <nav>
        <div class="new-chat-control">
          <button type="button" class="nav-action" aria-label="New chat" aria-haspopup="menu" aria-expanded={menu?.kind === 'picker'} onClick={(event) => toggleMenu('picker', null, event.currentTarget)}><i class="ri-add-line" /><span>New chat</span><i class="ri-arrow-down-s-line nav-action-chevron" /></button>
        </div>
        {onSearch && <button type="button" class="nav-action ghost search-action" aria-label="Search chats" onClick={() => setSearchOpen(true)}><i class="ri-search-line" /><span>Search chats</span></button>}

        {Array.isArray(bots) && (
          <div class="nav-section bots-section">
            <div class="nav-section-label-row">
              <strong><i class="ri-robot-2-line" aria-hidden="true" /><span>Bots</span><small>{botsWithStatus.length}</small></strong>
              <span class="section-actions">
                {onSnoozeBots && (
                  <button
                    type="button"
                    class={`section-action${schedulerSnooze?.active ? ' active' : ''}`}
                    aria-label={schedulerSnooze?.active ? 'Change bots snooze' : 'Snooze bots'}
                    title={schedulerSnooze?.active
                      ? (schedulerSnooze.mode === 'until-restart' ? 'Bots snoozed until restart' : `Bots snoozed until ${new Date(schedulerSnooze.until).toLocaleString()}`)
                      : 'Snooze bots'}
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === 'snooze'}
                    onClick={(event) => toggleMenu('snooze', null, event.currentTarget)}
                  ><i class="ri-moon-line" /></button>
                )}
                {onCreateBot && <button type="button" class="section-action" aria-label="New bot" title="New bot" onClick={() => setBotDialog({ bot: null })}><i class="ri-add-line" /></button>}
              </span>
            </div>
            {botsWithStatus.length ? (
              <ul class="bot-list">
                {botsWithStatus.map((bot) => {
                  const menuOpen = menu?.kind === 'bot' && menu.id === bot.id;
                  const snoozed = snoozeRemainingText(bot.snooze);
                  return (
                    <li key={bot.id} class={`bot-row${bot.conversationId === selectedId ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`}>
                      <button
                        type="button"
                        class="bot-open"
                        aria-label={`${bot.name} — ${bot.status.label}`}
                        onClick={() => { if (bot.conversationId) { onSelect(bot.conversationId); onClose?.(); } }}
                      >
                        <i class={`bot-status-dot ${bot.status.state}`} title={bot.status.label} aria-label={bot.status.label} />
                        <span><strong>{bot.name}</strong><small>{snoozed ? `Snoozed ${snoozed}` : bot.status.label}</small></span>
                        {bot.attentionCount > 0 && <b class="bot-attention" aria-label={`${bot.attentionCount} action${bot.attentionCount === 1 ? '' : 's'} need attention`}>{bot.attentionCount}</b>}
                      </button>
                      <button type="button" class="bot-menu" aria-label={`Actions for ${bot.name}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => toggleMenu('bot', bot.id, event.currentTarget, bot)}><i class="ri-more-2-line" /></button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p class="sidebar-empty">Autonomous teammates. They find, organize, and delegate work periodically.</p>
            )}
          </div>
        )}

        <div class="nav-section folder-conversations">
          <div class="nav-section-label-row">
            <strong><span>Conversations</span><small>{visibleConversations.length}</small></strong>
            {(Array.isArray(tags) || onSaveTags) && (
              <button
                type="button"
                class={`section-action${filterActive ? ' active' : ''}`}
                aria-label="Filter conversations"
                title="Filter conversations"
                aria-haspopup="menu"
                aria-expanded={menu?.kind === 'filter'}
                onClick={(event) => toggleMenu('filter', null, event.currentTarget)}
              ><i class="ri-filter-3-line" /></button>
            )}
          </div>
          {hasTaskGroups && taskGroupSection('Working', 'task:working', taskGroups.working, true)}
          {taskGroups.review.length > 0 && taskGroupSection('Review', 'task:review', taskGroups.review, false)}
          {hasTaskGroups && <div class="folders-label">Folders</div>}
          {navigation.groups.length ? navigation.groups.map((group) => {
            const open = openGroups[group.key] !== false;
            const expanded = Boolean(expandedGroups[group.key]);
            const visibleItems = expanded ? group.items : group.items.slice(0, FOLDER_GROUP_LIMIT);
            return (
              <section class="conversation-folder" key={group.key}>
                <header>
                  <button type="button" class="folder-toggle" aria-expanded={open} aria-label={`${group.label} folder`} title={group.displayPath} onClick={() => setOpenGroups((current) => ({ ...current, [group.key]: !open }))}><i class={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} /><i class={group.isHome ? 'ri-home-4-line' : 'ri-folder-line'} style={group.color && !group.isHome ? { color: group.color } : undefined} /><span>{group.label}</span></button>
                  {onSaveFolderColor && group.path && !group.isHome && (
                    <button
                      type="button"
                      class={`folder-color${menu?.kind === 'color' && menu.id === group.key ? ' active' : ''}`}
                      aria-label={`Color for ${group.label}`}
                      title="Folder color"
                      aria-haspopup="menu"
                      aria-expanded={menu?.kind === 'color' && menu.id === group.key}
                      onClick={(event) => toggleMenu('color', group.key, event.currentTarget, group)}
                    ><i class="ri-palette-line" />{group.color && <span class="tag-dot" style={{ background: group.color }} />}</button>
                  )}
                  <button type="button" class="folder-new-chat" aria-label={`New chat with ${group.label}`} title={`New chat with ${group.label}`} onClick={() => { onCreate(group); onClose?.(); }}><i class="ri-add-line" /></button>
                </header>
                {open && (
                  <>
                    <ul class="thread-list">{visibleItems.map((item) => renderThreadRow(item, item.gitBranch ?? group.label, item.gitBranch ? `Branch: ${item.gitBranch}` : group.displayPath, `${group.key}:${item.id}`))}</ul>
                    {group.items.length > FOLDER_GROUP_LIMIT && (
                      <button type="button" class="show-more" aria-expanded={expanded} onClick={() => toggleExpanded(group.key)}>
                        <span>{expanded ? 'Show less' : `Show ${group.items.length - FOLDER_GROUP_LIMIT} more`}</span>
                        <i class={expanded ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line'} aria-hidden="true" />
                      </button>
                    )}
                  </>
                )}
              </section>
            );
          }) : !hasTaskGroups ? <p class="sidebar-empty">No conversations yet.</p> : null}
        </div>
      </nav>
      <footer><button aria-label={`Disconnect ${connection.label}`} onClick={onExit}><i class="ri-links-line" /><span>{connection.label}</span></button></footer>
      {menu && createPortal(
        <div
          ref={popoverRef}
          class={`sidebar-popover ${menuClass}`}
          role="menu"
          aria-label={menuLabel}
          style={{ left: menuPosition?.left ?? -10_000, top: menuPosition?.top ?? -10_000 }}
        >{menuContent}</div>,
        document.body,
      )}
      {searchOpen && onSearch && (
        <SidebarSearchDialog
          onSearch={onSearch}
          onSelect={(conversationId) => { setSearchOpen(false); onSelect(conversationId); onClose?.(); }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {tagsDialogOpen && onSaveTags && (
        <SidebarTagsDialog
          tags={tags ?? []}
          onClose={() => setTagsDialogOpen(false)}
          onSave={(nextTags) => { onSaveTags(nextTags); setTagsDialogOpen(false); }}
        />
      )}
      {botDialog && (botDialog.bot ? onUpdateBot : onCreateBot) && (
        <SidebarBotDialog
          bot={botDialog.bot}
          models={models}
          folders={folders}
          onClose={() => setBotDialog(null)}
          onSubmit={(changes) => {
            if (botDialog.bot) onUpdateBot(botDialog.bot, changes);
            else onCreateBot(changes);
            setBotDialog(null);
          }}
        />
      )}
    </aside>
  );
}
