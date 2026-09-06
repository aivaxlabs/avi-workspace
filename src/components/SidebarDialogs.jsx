import { useEffect, useRef, useState } from 'preact/hooks';
import { normalizeSearchResults } from '../lib/sidebar-state.js';
import { useModalFocus } from '../lib/use-modal-focus.js';

const TAG_COLORS = Object.freeze(['#e5484d', '#f76b15', '#e3b341', '#46a758', '#12a594', '#3e9df0', '#3e63dd', '#8e4ec6', '#d6409f', '#8b8d98']);

function formatAge(timestamp) {
  const time = Date.parse(timestamp ?? '');
  if (!Number.isFinite(time)) return null;
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(time).toLocaleDateString();
}

export function DialogShell({ title, search = false, onClose, onKeyDown, initialFocusRef, children }) {
  const dialogRef = useRef(null);
  useModalFocus({ containerRef: dialogRef, onClose, initialFocusRef });
  return (
    <div class="sidebar-dialog-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        class={`sidebar-dialog${search ? ' search-dialog' : ' manage-dialog'}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {search ? children : (
          <>
            <header>
              <h2>{title}</h2>
              <button type="button" aria-label="Close dialog" onClick={onClose}><i class="ri-close-line" /></button>
            </header>
            {children}
          </>
        )}
      </section>
    </div>
  );
}

export function SidebarSearchDialog({ onSearch, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const resultsRef = useRef(null);
  const inputRef = useRef(null);
  const tokenRef = useRef(0);

  function searchNow() {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      setError('');
      return;
    }
    const token = ++tokenRef.current;
    setSearching(true);
    setError('');
    Promise.resolve(onSearch(trimmed)).then((found) => {
      if (token !== tokenRef.current) return;
      setResults(normalizeSearchResults(found));
      setSelected(0);
    }).catch((value) => {
      if (token !== tokenRef.current) return;
      setResults([]);
      setSelected(0);
      setError(value instanceof Error ? value.message : String(value));
    }).finally(() => {
      if (token === tokenRef.current) setSearching(false);
    });
  }

  useEffect(() => {
    const handle = setTimeout(searchNow, 200);
    return () => {
      clearTimeout(handle);
      tokenRef.current += 1;
    };
  }, [query]);

  useEffect(() => {
    resultsRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  function choose(result) {
    if (!result) return;
    onSelect(result.conversationId);
    onClose();
  }

  function onKeyDown(event) {
    const target = event.target;
    const fromInput = target === inputRef.current;
    const fromResult = Boolean(target?.closest?.('[role="option"]'));
    if (!fromInput && !fromResult) return;
    if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      setSelected((current) => (current + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault();
      setSelected((current) => (current - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[selected]);
    }
  }

  return (
    <DialogShell title="Search chats" search onClose={onClose} onKeyDown={onKeyDown} initialFocusRef={inputRef}>
      <label class="dialog-search">
        <i class="ri-search-line" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search chats"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="sidebar-search-results"
          aria-activedescendant={results[selected] ? `sidebar-search-result-${selected}` : undefined}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        {searching ? <i class="ri-loader-4-line spinning" role="status" aria-label="Searching" /> : <kbd>Esc</kbd>}
      </label>
      {query.trim() && (error && !searching ? (
        <div class="search-error" role="alert">
          <i class="ri-error-warning-line" aria-hidden="true" />
          <span>Could not search: {error}</span>
          <button type="button" class="dialog-secondary" onClick={searchNow}>Retry</button>
        </div>
      ) : (
        <div ref={resultsRef} id="sidebar-search-results" class="search-results" role="listbox" aria-label="Chat search results">
          {!searching && results.length > 0 && <div class="search-results-label">Results<span>{results.length}</span></div>}
          {results.map((result, index) => (
            <button
              key={result.conversationId}
              id={`sidebar-search-result-${index}`}
              data-index={index}
              type="button"
              role="option"
              aria-selected={index === selected}
              class={index === selected ? 'active' : ''}
              onMouseMove={() => setSelected(index)}
              onClick={() => choose(result)}
            >
              <i class="ri-chat-3-line" aria-hidden="true" />
              <span class="search-result-copy">
                <span class="search-result-heading">
                  <strong>{result.title}</strong>
                  <small title={result.folderDisplayPath}>{result.folderName}</small>
                  {formatAge(result.updatedAt) && <span class="search-result-age" title={result.updatedAt ? new Date(result.updatedAt).toLocaleString() : undefined}>{formatAge(result.updatedAt)}</span>}
                </span>
                <span class="search-result-preview">{result.content || 'No preview available.'}</span>
              </span>
            </button>
          ))}
          {!searching && results.length === 0 && (
            <div class="search-empty"><i class="ri-search-line" aria-hidden="true" /><span>No chats found for that query.</span></div>
          )}
        </div>
      ))}
    </DialogShell>
  );
}

export function SidebarTagsDialog({ tags, onClose, onSave, busy = false, error = '' }) {
  const [draft, setDraft] = useState(() => (Array.isArray(tags) ? tags : []).map((tag) => ({ ...tag })));
  const firstFieldRef = useRef(null);

  function updateTag(id, changes) {
    setDraft((current) => current.map((tag) => (tag.id === id ? { ...tag, ...changes } : tag)));
  }
  function addTag() {
    setDraft((current) => [...current, {
      id: globalThis.crypto?.randomUUID?.() ?? `tag-${current.length}-${Date.now().toString(36)}`,
      name: '',
      color: TAG_COLORS[current.length % TAG_COLORS.length],
    }]);
  }

  return (
    <DialogShell title="Manage tags" onClose={onClose} initialFocusRef={firstFieldRef}>
      <div class="dialog-body">
        {draft.map((tag, index) => (
          <div class="tag-row" key={tag.id}>
            <input
              class="tag-color"
              type="color"
              value={tag.color ?? TAG_COLORS[0]}
              aria-label={`Color for ${tag.name || 'new tag'}`}
              onInput={(event) => updateTag(tag.id, { color: event.currentTarget.value })}
            />
            <input
              ref={index === 0 ? firstFieldRef : undefined}
              type="text"
              value={tag.name}
              placeholder="Tag name"
              aria-label="Tag name"
              onInput={(event) => updateTag(tag.id, { name: event.currentTarget.value })}
            />
            <button
              type="button"
              class="tag-remove"
              aria-label={`Remove tag ${tag.name || 'unnamed'}`.trim()}
              onClick={() => setDraft((current) => current.filter((item) => item.id !== tag.id))}
            ><i class="ri-delete-bin-line" /></button>
          </div>
        ))}
        {!draft.length && <p class="dialog-empty">No tags yet. Create the first one.</p>}
        <button type="button" class="dialog-secondary" disabled={busy} onClick={addTag}><i class="ri-add-line" aria-hidden="true" />New tag</button>
        {error && <p class="dialog-error" role="alert">{error}</p>}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" class="primary" disabled={busy} onClick={() => onSave(draft.filter((tag) => tag.name.trim()))}>Save tags</button>
      </footer>
    </DialogShell>
  );
}

export function SidebarBotDialog({ bot = null, models = [], folders = [], busy = false, error = '', onClose, onSubmit }) {
  const [name, setName] = useState(bot?.name ?? '');
  const [model, setModel] = useState(bot?.model ?? models[0]?.id ?? '');
  const [workingFolder, setWorkingFolder] = useState(bot?.workingFolder ?? '');
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);
  const nameInputRef = useRef(null);

  function submit(event) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    onSubmit({ name: name.trim(), model, workingFolder: workingFolder || null, enabled });
  }

  return (
    <DialogShell title={bot ? 'Edit bot' : 'Create bot'} onClose={onClose} initialFocusRef={nameInputRef}>
      <form class="dialog-body bot-form" onSubmit={submit}>
        <label>Name
          <input ref={nameInputRef} type="text" value={name} placeholder="Bot name" onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label>Model
          <select value={model} onChange={(event) => setModel(event.currentTarget.value)}>
            {models.map((item) => <option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}
          </select>
        </label>
        <label>Working folder
          <select value={workingFolder} onChange={(event) => setWorkingFolder(event.currentTarget.value)}>
            <option value="">Default working folder</option>
            {folders.map((folder) => <option key={folder.path} value={folder.path}>{folder.displayPath ?? folder.path}</option>)}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
          Enabled
        </label>
        {error && <p class="dialog-error" role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" class="primary" disabled={busy || !name.trim()}>{bot ? 'Save bot' : 'Create bot'}</button>
        </footer>
      </form>
    </DialogShell>
  );
}

export function SidebarPromptDialog({ title, description, inputLabel, initialValue = '', placeholder, confirmLabel = 'Confirm', danger = false, busy = false, error = '', onConfirm, onClose }) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef(null);
  const cancelRef = useRef(null);
  const submitting = useRef(false);
  const textAction = Boolean(inputLabel);

  function submit(event) {
    event.preventDefault();
    if (busy || submitting.current) return;
    const trimmed = value.trim();
    if (textAction && !trimmed) return;
    if (textAction && trimmed === String(initialValue).trim()) {
      onClose();
      return;
    }
    submitting.current = true;
    Promise.resolve(onConfirm(textAction ? trimmed : undefined)).finally(() => { submitting.current = false; });
  }

  return (
    <DialogShell title={title} onClose={onClose} initialFocusRef={textAction ? inputRef : cancelRef}>
      <form class="dialog-body prompt-form" onSubmit={submit}>
        {description && <p class="prompt-description">{description}</p>}
        {textAction && (
          <label>{inputLabel}
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={placeholder}
              onInput={(event) => setValue(event.currentTarget.value)}
            />
          </label>
        )}
        {error && <p class="dialog-error" role="alert">{error}</p>}
        <footer>
          <button type="button" ref={cancelRef} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" class={`primary${danger ? ' danger' : ''}`} disabled={busy || (textAction && !value.trim())}>{confirmLabel}</button>
        </footer>
      </form>
    </DialogShell>
  );
}
