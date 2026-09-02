import { useEffect, useRef, useState } from 'preact/hooks';
import { normalizeSearchResults } from '../lib/sidebar-state.js';

const TAG_COLORS = Object.freeze(['#8aa7ff', '#66c58a', '#e0aa61', '#ee7d7d', '#c58ae0', '#5fc8c0', '#e0d361', '#8a8f99']);

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

function useDialogDismiss(onClose) {
  const firstFieldRef = useRef(null);
  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return firstFieldRef;
}

function DialogShell({ title, search = false, onClose, onKeyDown, children }) {
  return (
    <div class="sidebar-dialog-backdrop" onMouseDown={onClose}>
      <section
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
  const [selected, setSelected] = useState(0);
  const resultsRef = useRef(null);
  const tokenRef = useRef(0);
  const inputRef = useDialogDismiss(onClose);

  useEffect(() => {
    const token = ++tokenRef.current;
    const handle = setTimeout(async () => {
      const trimmed = query.trim();
      if (!trimmed) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const next = normalizeSearchResults(await onSearch(trimmed));
        if (token === tokenRef.current) {
          setResults(next);
          setSelected(0);
        }
      } catch {
        if (token === tokenRef.current) {
          setResults([]);
          setSelected(0);
        }
      } finally {
        if (token === tokenRef.current) setSearching(false);
      }
    }, 200);
    return () => clearTimeout(handle);
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
    <DialogShell title="Search chats" search onClose={onClose} onKeyDown={onKeyDown}>
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
      {query.trim() && (
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
      )}
    </DialogShell>
  );
}

export function SidebarTagsDialog({ tags, onClose, onSave }) {
  const [draft, setDraft] = useState(() => (Array.isArray(tags) ? tags : []).map((tag) => ({ ...tag })));
  const firstFieldRef = useDialogDismiss(onClose);

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
    <DialogShell title="Manage tags" onClose={onClose}>
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
        <button type="button" class="dialog-secondary" onClick={addTag}><i class="ri-add-line" aria-hidden="true" />New tag</button>
      </div>
      <footer>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" class="primary" onClick={() => onSave(draft.filter((tag) => tag.name.trim()))}>Save tags</button>
      </footer>
    </DialogShell>
  );
}

export function SidebarBotDialog({ bot = null, models = [], folders = [], onClose, onSubmit }) {
  const [name, setName] = useState(bot?.name ?? '');
  const [model, setModel] = useState(bot?.model ?? models[0]?.id ?? '');
  const [workingFolder, setWorkingFolder] = useState(bot?.workingFolder ?? '');
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);
  const firstFieldRef = useDialogDismiss(onClose);

  function submit(event) {
    event.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), model, workingFolder: workingFolder || null, enabled });
  }

  return (
    <DialogShell title={bot ? 'Edit bot' : 'Create bot'} onClose={onClose}>
      <form class="dialog-body bot-form" onSubmit={submit}>
        <label>Name
          <input ref={firstFieldRef} type="text" value={name} placeholder="Bot name" onInput={(event) => setName(event.currentTarget.value)} />
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
        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" class="primary" disabled={!name.trim()}>{bot ? 'Save bot' : 'Create bot'}</button>
        </footer>
      </form>
    </DialogShell>
  );
}
