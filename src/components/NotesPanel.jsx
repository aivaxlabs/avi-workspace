import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { METHODS, supportsMethod, ATTACHMENT_CHUNK_SIZE, normalizeNoteAttachmentChunk, normalizeNoteUploadResult } from '../rpc/contracts.js';
import { useModalFocus } from '../lib/use-modal-focus.js';

const priorities = ['none', 'low', 'medium', 'high', 'urgent'];
const orders = [['urgency', 'Urgency'], ['createdAt', 'Creation time'], ['updatedAt', 'Updated time'], ['priority', 'Priority'], ['dueAt', 'Due time'], ['manual', 'Manual']];

export function NotesPanel({ client, discovery, folderPath = null }) {
  const [lists, setLists] = useState([]);
  const [notes, setNotes] = useState([]);
  const [filters, setFilters] = useState({ query: '', status: 'active', priority: '', time: 'due', after: '', before: '', allFolders: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const dialogRef = useRef(null);
  const available = supportsMethod(discovery, METHODS.noteLists) && supportsMethod(discovery, METHODS.searchNotes);
  useModalFocus({ open: Boolean(editor || confirm), containerRef: dialogRef, onClose: () => { if (!lock.current) { setEditor(null); setConfirm(null); } } });
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, [client, folderPath]);
  useEffect(() => {
    if (!available) { setLoading(false); return undefined; }
    let active = true;
    let inFlight = false;
    const sequence = ++generation.current;
    const refresh = async () => {
      if (inFlight || client.closed) return;
      inFlight = true;
      try {
        const scope = filters.allFolders ? {} : { folderPath };
        const result = await client.request(METHODS.noteLists, { ...scope, archived: null });
        const shownLists = result.filter((list) => filters.status === 'archived' || filters.status === 'all' || !list.archived);
        const batches = await Promise.all(shownLists.map((list) => client.request(METHODS.searchNotes, {
          listIds: [list.id], query: filters.query, archived: filters.status === 'all' || filters.status === 'archived' ? null : false,
          ...(filters.status === 'done' ? { done: true } : filters.status === 'open' ? { done: false } : {}),
          ...(filters.priority ? { priority: filters.priority } : {}), orderBy: list.orderBy, limit: 5000,
          ...(filters.after ? { [`${filters.time}After`]: new Date(`${filters.after}T00:00:00`).toISOString() } : {}),
          ...(filters.before ? { [`${filters.time}Before`]: new Date(`${filters.before}T23:59:59.999`).toISOString() } : {}),
        })));
        if (active && sequence === generation.current) {
          setLists(result);
          setNotes(batches.flatMap((batch) => batch.notes));
          if (batches.some((batch) => batch.total > 5000)) setError('Showing up to 5,000 matching notes per list. Narrow the filters to see more.');
        }
      } catch (failure) { if (active && sequence === generation.current) setError(failure.message); }
      finally { inFlight = false; if (active) setLoading(false); }
    };
    setLoading(true);
    const timeout = setTimeout(refresh, 200);
    const interval = setInterval(refresh, 5000);
    return () => { active = false; clearTimeout(timeout); clearInterval(interval); };
  }, [client, discovery, available, folderPath, filters, revision]);

  async function request(method, payload) {
    if (!supportsMethod(discovery, method)) throw new Error('This action is not supported by the connected Avi.');
    if (client.closed) throw new Error('The connection to Avi is closed.');
    return client.request(method, payload);
  }

  async function mutate(action) {
    if (lock.current) return null;
    lock.current = true; setBusy(true); setError('');
    try { return await action(); }
    catch (failure) { if (alive.current) setError(failure.message); return null; }
    finally { lock.current = false; if (alive.current) { setBusy(false); setProgress(''); setRevision((value) => value + 1); } }
  }

  function editNote(note) {
    setEditor({ ...note, kind: 'note', subtasks: note.subtasks.map((item) => ({ ...item })),
      dueAt: note.dueAt ? new Date(Date.parse(note.dueAt) - new Date(note.dueAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' });
  }

  async function move(items, index, direction, listId) {
    if (index + direction < 0 || index + direction >= items.length) return;
    const ids = items.map((item) => item.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    await mutate(() => request(METHODS.reorderNotes, { ids, ...(listId ? { listId } : {}) }));
  }

  const visibleLists = lists.filter((list) => filters.status === 'all' || filters.status === 'archived' || !list.archived);
  if (!available) return <p class="panel-empty">Notes is not available on this Avi instance. Update Avi Desktop to use it.</p>;

  return <section class="notes-panel" aria-label="User notes">
    <header class="notes-toolbar"><input type="search" aria-label="Search notes" placeholder="Search notes..." value={filters.query} onInput={(event) => setFilters({ ...filters, query: event.currentTarget.value })} />
      <details class="notes-filters"><summary aria-label="Filter notes"><i class="ri-filter-3-line" /></summary><div>
        <label>Status<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.currentTarget.value })}><option value="active">Not archived</option><option value="open">Not done</option><option value="done">Done</option><option value="archived">Archived</option><option value="all">All</option></select></label>
        <label>Priority<select value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.currentTarget.value })}><option value="">Any</option>{priorities.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Time<select value={filters.time} onChange={(event) => setFilters({ ...filters, time: event.currentTarget.value })}><option value="created">Creation time</option><option value="updated">Updated time</option><option value="due">Due time</option></select></label>
        <label>From<input type="date" value={filters.after} onChange={(event) => setFilters({ ...filters, after: event.currentTarget.value })} /></label><label>Through<input type="date" value={filters.before} onChange={(event) => setFilters({ ...filters, before: event.currentTarget.value })} /></label>
        <label class="notes-check"><input type="checkbox" checked={filters.allFolders} onChange={(event) => setFilters({ ...filters, allFolders: event.currentTarget.checked })} />All working folders</label>
      </div></details>
      <button type="button" aria-label="New note list" disabled={busy || !supportsMethod(discovery, METHODS.saveNoteList)} onClick={() => setEditor({ kind: 'list', name: '', folderPath })}><i class="ri-add-line" /></button>
    </header>
    <small class="notes-scope">{filters.allFolders ? 'All working folders' : folderPath ?? 'No working folder'}</small>
    {error && !editor && !confirm && <p class="inline-error" role="alert">{error}</p>}
    {loading && <p role="status">Loading notes...</p>}
    {!loading && !visibleLists.length && <p class="panel-empty">No lists yet. Create a list to start taking notes.</p>}
    {visibleLists.map((list, listIndex) => {
      const items = notes.filter((note) => note.listId === list.id && (filters.status !== 'archived' || list.archived || note.archived));
      return <details class="notes-list" key={list.id} open>
        <summary><strong>{list.name}{list.archived ? ' (archived)' : ''}</strong><small>{items.length}</small></summary>
        <div class="notes-list-actions"><button type="button" disabled={busy || list.archived || !supportsMethod(discovery, METHODS.saveNote)} onClick={() => editNote({ listId: list.id, title: '', description: '', priority: 'none', dueAt: null, subtasks: [], attachments: [] })}><i class="ri-add-line" />New note</button>
          <details class="notes-options"><summary aria-label={`List options: ${list.name}`}><i class="ri-more-line" /></summary><div>
            <button type="button" disabled={busy || !supportsMethod(discovery, METHODS.saveNoteList)} onClick={() => setEditor({ ...list, kind: 'list' })}>Rename list</button>
            <button type="button" disabled={busy || !supportsMethod(discovery, METHODS.saveNoteList)} onClick={() => mutate(() => request(METHODS.saveNoteList, { id: list.id, archived: !list.archived }))}>{list.archived ? 'Restore list' : 'Archive list'}</button>
            <label>Order by<select value={list.orderBy} disabled={busy || !supportsMethod(discovery, METHODS.saveNoteList)} onChange={(event) => mutate(() => request(METHODS.saveNoteList, { id: list.id, orderBy: event.currentTarget.value }))}>{orders.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button type="button" disabled={busy || !listIndex || !supportsMethod(discovery, METHODS.reorderNotes)} onClick={() => move(visibleLists, listIndex, -1)}>Move list up</button>
            <button type="button" disabled={busy || listIndex === visibleLists.length - 1 || !supportsMethod(discovery, METHODS.reorderNotes)} onClick={() => move(visibleLists, listIndex, 1)}>Move list down</button>
            <button type="button" disabled={busy || !supportsMethod(discovery, METHODS.deleteNoteList)} onClick={() => setConfirm({ id: list.id, archivedOnly: true, name: list.name })}>Delete archived notes</button>
            <button type="button" disabled={busy || !supportsMethod(discovery, METHODS.deleteNoteList)} onClick={() => setConfirm({ id: list.id, archivedOnly: false, name: list.name })}>Delete list</button>
          </div></details>
        </div>
        <ul>{items.map((note, index) => <li key={note.id} class={note.done ? 'is-done' : ''}>
          <input type="checkbox" checked={note.done} aria-label={`Complete ${note.title}`} disabled={busy || !supportsMethod(discovery, METHODS.saveNote)} onChange={(event) => mutate(() => request(METHODS.saveNote, { id: note.id, done: event.currentTarget.checked }))} />
          <button type="button" class="notes-copy" onClick={() => editNote(note)}><strong>{note.title}</strong>{note.description && <span>{note.description}</span>}<small>{[note.priority !== 'none' ? note.priority : '', note.dueAt ? new Date(note.dueAt).toLocaleString() : '', note.subtasks.length ? `${note.subtasks.filter((item) => item.done).length}/${note.subtasks.length} subtasks` : '', note.attachments.length ? `${note.attachments.length} files` : '', note.archived ? 'Archived' : ''].filter(Boolean).join(' · ')}</small></button>
          <details class="notes-options"><summary aria-label={`Note options: ${note.title}`}><i class="ri-more-line" /></summary><div>
            <button type="button" onClick={() => editNote(note)}>Edit note, deadline and subtasks</button><button type="button" onClick={() => editNote(note)}>Manage attachments</button>
            <button type="button" disabled={busy || !supportsMethod(discovery, METHODS.saveNote)} onClick={() => mutate(() => request(METHODS.saveNote, { id: note.id, archived: !note.archived }))}>{note.archived ? 'Restore note' : 'Archive note'}</button>
            <button type="button" disabled={busy || !index || !supportsMethod(discovery, METHODS.reorderNotes)} onClick={() => move(items, index, -1, list.id)}>Move note up</button>
            <button type="button" disabled={busy || index === items.length - 1 || !supportsMethod(discovery, METHODS.reorderNotes)} onClick={() => move(items, index, 1, list.id)}>Move note down</button>
          </div></details>
        </li>)}</ul>{!items.length && <p class="panel-empty">No matching notes.</p>}
      </details>;
    })}
    {(editor || confirm) && createPortal(<div class="notes-dialog-backdrop"><section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="notes-editor-title" class="notes-editor"><form onSubmit={async (event) => {
      event.preventDefault();
      const result = await mutate(() => confirm ? request(METHODS.deleteNoteList, { id: confirm.id, archivedOnly: confirm.archivedOnly }) : editor.kind === 'list' ? request(METHODS.saveNoteList, { id: editor.id, name: editor.name, folderPath: editor.folderPath }) : request(METHODS.saveNote, { id: editor.id, listId: editor.listId, title: editor.title, description: editor.description, priority: editor.priority, dueAt: editor.dueAt ? new Date(editor.dueAt).toISOString() : null, subtasks: editor.subtasks }));
      if (result && alive.current) { setEditor(null); setConfirm(null); }
    }}>
      <header><h2 id="notes-editor-title">{confirm ? 'Delete notes' : editor.kind === 'list' ? 'Note list' : 'Note'}</h2><button type="button" aria-label="Close note editor" disabled={busy} onClick={() => { setEditor(null); setConfirm(null); }}><i class="ri-close-line" /></button></header>
      {confirm ? <p>Delete {confirm.archivedOnly ? 'all archived notes in' : 'the list and all notes in'} “{confirm.name}”? Stored attachments are permanently removed.</p> : editor.kind === 'list' ? <label>List name<input required maxLength={200} value={editor.name} disabled={busy} onInput={(event) => setEditor({ ...editor, name: event.currentTarget.value })} /></label> : <>
        <label>Title<input required maxLength={500} value={editor.title} disabled={busy} onInput={(event) => setEditor({ ...editor, title: event.currentTarget.value })} /></label>
        <label>List<select value={editor.listId} disabled={busy} onChange={(event) => setEditor({ ...editor, listId: event.currentTarget.value })}>{lists.filter((list) => !list.archived || list.id === editor.listId).map((list) => <option key={list.id} value={list.id}>{list.name}{filters.allFolders ? ` — ${list.folderPath ?? 'No folder'}` : ''}</option>)}</select></label>
        <label>Priority<select value={editor.priority} disabled={busy} onChange={(event) => setEditor({ ...editor, priority: event.currentTarget.value })}>{priorities.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Due date<input type="datetime-local" value={editor.dueAt} disabled={busy} onInput={(event) => setEditor({ ...editor, dueAt: event.currentTarget.value })} /></label>
        <label>Text<textarea rows={5} maxLength={200000} value={editor.description} disabled={busy} onInput={(event) => setEditor({ ...editor, description: event.currentTarget.value })} /></label>
        <h3>Subtasks</h3>{editor.subtasks.map((task, index) => <div class="notes-subtask" key={task.id}>
          <input type="checkbox" checked={task.done} disabled={busy} aria-label={`Complete subtask ${index + 1}`} onChange={(event) => setEditor({ ...editor, subtasks: editor.subtasks.map((item, at) => at === index ? { ...item, done: event.currentTarget.checked } : item) })} />
          <input required aria-label={`Subtask ${index + 1}`} value={task.text} maxLength={2000} disabled={busy} onInput={(event) => setEditor({ ...editor, subtasks: editor.subtasks.map((item, at) => at === index ? { ...item, text: event.currentTarget.value } : item) })} />
          {[-1, 1].map((direction) => <button type="button" key={direction} disabled={busy || index + direction < 0 || index + direction >= editor.subtasks.length} aria-label={`Move subtask ${index + 1} ${direction < 0 ? 'up' : 'down'}`} onClick={() => { const items = [...editor.subtasks]; [items[index], items[index + direction]] = [items[index + direction], items[index]]; setEditor({ ...editor, subtasks: items }); }}><i class={direction < 0 ? 'ri-arrow-up-line' : 'ri-arrow-down-line'} /></button>)}
          <button type="button" disabled={busy} aria-label={`Remove subtask ${index + 1}`} onClick={() => setEditor({ ...editor, subtasks: editor.subtasks.filter((_, at) => at !== index) })}><i class="ri-close-line" /></button>
        </div>)}<button type="button" disabled={busy || editor.subtasks.length >= 500} onClick={() => setEditor({ ...editor, subtasks: [...editor.subtasks, { id: crypto.randomUUID(), text: '', done: false }] })}>Add subtask</button>
        <h3>Attachments</h3>{editor.attachments.map((attachment) => <div class="notes-file" key={attachment.id}><span>{attachment.name}</span>
          <button type="button" disabled={busy || !supportsMethod(discovery, METHODS.readNoteAttachment)} aria-label={`Download ${attachment.name}`} onClick={() => mutate(async () => {
            const chunks = []; let offset = 0;
            do {
              const chunk = await request(METHODS.readNoteAttachment, { id: editor.id, attachmentId: attachment.id, offset, length: ATTACHMENT_CHUNK_SIZE });
              const bytes = normalizeNoteAttachmentChunk(chunk, { offset, size: attachment.size });
              chunks.push(bytes); offset += bytes.length;
              if (!alive.current) return;
              setProgress(`Downloading ${attachment.name}: ${Math.round(offset / Math.max(1, attachment.size) * 100)}%`);
            } while (offset < attachment.size);
            const url = URL.createObjectURL(new Blob(chunks));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = attachment.name; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })}><i class="ri-download-line" /></button>
          <button type="button" disabled={busy || !supportsMethod(discovery, METHODS.saveNote)} aria-label={`Remove ${attachment.name}`} onClick={async () => { const result = await mutate(() => request(METHODS.saveNote, { id: editor.id, removeAttachmentIds: [attachment.id] })); if (result && alive.current) setEditor((current) => ({ ...current, attachments: result.attachments })); }}><i class="ri-close-line" /></button>
        </div>)}
        <label>Add files<input type="file" multiple disabled={busy || !editor.id || !supportsMethod(discovery, METHODS.uploadNoteAttachment)} onChange={async (event) => {
          const files = [...event.currentTarget.files]; event.currentTarget.value = '';
          await mutate(async () => {
            for (const file of files) {
              if (file.size > 50 * 1024 * 1024) throw new Error('Files must be at most 50 MiB.');
              let uploadId; let offset = 0;
              try {
                do {
                  const bytes = new Uint8Array(await file.slice(offset, offset + ATTACHMENT_CHUNK_SIZE).arrayBuffer());
                  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
                  const result = await request(METHODS.uploadNoteAttachment, { id: editor.id, ...(uploadId ? { uploadId } : { name: file.name, size: file.size }), offset, data: btoa(binary) });
                  uploadId = result.uploadId;
                  normalizeNoteUploadResult(result, { offset, length: bytes.length, size: file.size });
                  offset = result.offset;
                  if (!alive.current) {
                    if (!result.complete && !client.closed) await request(METHODS.uploadNoteAttachment, { id: editor.id, uploadId, cancel: true }).catch(() => {});
                    return;
                  }
                  setProgress(`Uploading ${file.name}: ${Math.round(offset / Math.max(1, file.size) * 100)}%`);
                  if (result.complete) { setEditor((current) => ({ ...current, attachments: result.note.attachments })); break; }
                } while (offset < file.size);
              } catch (failure) {
                if (uploadId && !client.closed) await request(METHODS.uploadNoteAttachment, { id: editor.id, uploadId, cancel: true }).catch(() => {});
                throw failure;
              }
            }
          });
        }} /></label><small>{editor.id ? 'Up to 50 files, 50 MiB each. Attachment changes are saved immediately.' : 'Save the note before adding files.'}</small>
      </>}
      {progress && <p role="status">{progress}</p>}{error && <p class="inline-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={() => { setEditor(null); setConfirm(null); }}>Cancel</button><button type="submit" disabled={busy || !supportsMethod(discovery, confirm ? METHODS.deleteNoteList : editor.kind === 'list' ? METHODS.saveNoteList : METHODS.saveNote)}>{busy ? 'Working...' : confirm ? 'Delete permanently' : 'Save'}</button></footer>
    </form></section></div>, document.body)}
  </section>;
}
