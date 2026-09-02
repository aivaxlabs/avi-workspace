import { useEffect, useRef, useState } from 'preact/hooks';
import { deleteConnection, listConnections, saveConnection } from '../storage/connections.js';

const EMPTY_FORM = { id: '', label: '', serverUrl: 'http://127.0.0.1:18992', apiKey: '' };

export function ConnectionsPage({ statuses, onEnter, onCheck }) {
  const [connections, setConnections] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const dialogRef = useRef(null);
  const openerRef = useRef(null);

  const refresh = () => listConnections().then(setConnections).catch((value) => setError(value.message));
  useEffect(refresh, []);
  useEffect(() => { connections.forEach(onCheck); }, [connections.length]);
  useEffect(() => {
    if (!form) return;
    requestAnimationFrame(() => dialogRef.current?.querySelector('input')?.focus());
  }, [Boolean(form)]);

  function openForm(value) {
    openerRef.current = document.activeElement;
    setFormError('');
    setForm(value);
  }

  function closeForm() {
    setFormError('');
    setForm(null);
    requestAnimationFrame(() => openerRef.current?.focus());
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setFormError('');
    try {
      await saveConnection(form);
      closeForm();
      await refresh();
    } catch (value) {
      setFormError(value.message);
      if (value.message.includes('URL')) dialogRef.current?.querySelector('[name="serverUrl"]')?.focus();
    }
  }

  async function remove(connection) {
    if (!confirm(`Remove “${connection.label}”? The remote Avi data will not be changed.`)) return;
    await deleteConnection(connection.id);
    await refresh();
  }

  return <main class="connections-page">
    <header class="connections-header">
      <div><span class="wordmark">AVI</span><h1>Connections</h1><p>Remote Avi instances available to this browser.</p></div>
      <button class="primary" onClick={() => openForm({ ...EMPTY_FORM })}><i class="ri-add-line" /> Add connection</button>
    </header>
    {error && <p class="error-banner" role="alert">{error}</p>}
    <section class="connection-grid" aria-label="Configured Avi instances">
      {connections.map((connection) => {
        const status = statuses[connection.id] ?? { status: 'checking', detail: 'Checking...' };
        return <article class="connection-card" key={connection.id}>
          <header><div><h2>{connection.label}</h2><code>{connection.serverUrl}</code></div><span class={`connection-status ${status.status}`}><i />{status.status}</span></header>
          <p>{status.detail || (status.status === 'online' ? 'RPC API v1 available' : 'Remote instance unavailable')}</p>
          <footer>
            <button class="primary" disabled={status.status !== 'online'} onClick={() => onEnter(connection)}>Open workspace</button>
            <button aria-label={`Check ${connection.label}`} title="Check connection" onClick={() => onCheck(connection)}><i class="ri-refresh-line" /></button>
            <button aria-label={`Edit ${connection.label}`} title="Edit connection" onClick={() => openForm({ ...connection })}><i class="ri-pencil-line" /></button>
            <button class="danger-quiet" aria-label={`Remove ${connection.label}`} title="Remove connection" onClick={() => remove(connection)}><i class="ri-delete-bin-line" /></button>
          </footer>
        </article>;
      })}
      {connections.length === 0 && <div class="empty-connections"><i class="ri-links-line" /><h2>No remote instances</h2><p>Add an Avi URL and API key. Only connection records are stored in this browser.</p></div>}
    </section>
    {form && <div class="modal-backdrop" role="presentation" onKeyDown={(event) => {
      if (event.key === 'Escape') return closeForm();
      if (event.key !== 'Tab') return;
      const controls = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} onMouseDown={(event) => event.target === event.currentTarget && closeForm()}>
      <form ref={dialogRef} class="connection-dialog" role="dialog" aria-modal="true" onSubmit={submit} aria-label={form.id ? 'Edit connection' : 'Add connection'}>
        <header><div><h2>{form.id ? 'Edit connection' : 'Add connection'}</h2><p>The API key is stored in IndexedDB and sent only during the WebSocket handshake.</p></div><button type="button" aria-label="Close" onClick={closeForm}><i class="ri-close-line" /></button></header>
        <label>Name<input autofocus value={form.label} onInput={(event) => setForm({ ...form, label: event.currentTarget.value })} placeholder="Development Avi" /></label>
        <label>Remote Avi URL<input name="serverUrl" required aria-invalid={formError.includes('URL') || undefined} aria-describedby={formError ? 'connection-form-error' : undefined} value={form.serverUrl} onInput={(event) => setForm({ ...form, serverUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:18992" /></label>
        <label>API key<input required type="password" aria-describedby={formError ? 'connection-form-error' : undefined} value={form.apiKey} onInput={(event) => setForm({ ...form, apiKey: event.currentTarget.value })} autocomplete="off" /></label>
        {formError && <p id="connection-form-error" class="error-banner" role="alert">{formError}</p>}
        <footer><button type="button" onClick={closeForm}>Cancel</button><button type="submit" class="primary">Save connection</button></footer>
      </form>
    </div>}
  </main>;
}
