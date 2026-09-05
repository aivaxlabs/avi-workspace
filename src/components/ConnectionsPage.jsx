import { useEffect, useRef, useState } from 'preact/hooks';
import { useModalFocus } from '../lib/use-modal-focus.js';
import { AIVAX_LOGIN_URL, AIVAX_RELAYS_URL, requestAivax } from '../rpc/aivax.js';
import { deleteConnection, listConnections, loadAivaxAccessToken, saveAivaxAccessToken, saveConnection } from '../storage/connections.js';

const EMPTY_FORM = { label: '', serverUrl: 'http://127.0.0.1:18992', apiKey: '' };

export function ConnectionsPage({ statuses, onEnter, onCheck, onCancelOpen, openingId = null }) {
  const [connections, setConnections] = useState([]);
  const [aivaxOpen, setAivaxOpen] = useState(false);
  const [loginKey, setLoginKey] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [devices, setDevices] = useState(null);
  const [accountToken, setAccountToken] = useState('');
  const [remoteConnections, setRemoteConnections] = useState([]);
  const [aivaxError, setAivaxError] = useState('');
  const [aivaxBusy, setAivaxBusy] = useState(false);
  const aivaxDialogRef = useRef(null);
  const aivaxRequest = useRef(null);
  const closeAivax = () => {
    if (openingId) onCancelOpen?.();
    aivaxRequest.current?.abort();
    aivaxRequest.current = null;
    setAivaxBusy(false);
    setLoginKey('');
    setAccessToken('');
    setDevices(null);
    setAivaxOpen(false);
  };
  useModalFocus({ open: aivaxOpen, containerRef: aivaxDialogRef, onClose: closeAivax });
  useEffect(() => {
    let active = true;
    loadAivaxAccessToken().then((token) => {
      if (active && token) { setAccountToken(token); loadDevices(null, token); }
    }).catch(() => { if (active) setAivaxError('Could not read the saved AIVAX account.'); });
    return () => { active = false; aivaxRequest.current?.abort(); aivaxRequest.current = null; };
  }, []);

  async function loadDevices(event, savedToken = '') {
    event?.preventDefault();
    if (aivaxRequest.current) return;
    const controller = new AbortController();
    aivaxRequest.current = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    setAivaxBusy(true);
    setAivaxError('');
    setDevices(null);
    try {
      let token = savedToken || accessToken;
      if (!token) {
        const login = await requestAivax(AIVAX_LOGIN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loginKey: loginKey.trim() }), signal: controller.signal,
        });
        if (typeof login?.data?.accessToken !== 'string' || !login.data.accessToken) throw new Error('Invalid login response.');
        token = login.data.accessToken;
        if (controller.signal.aborted) return;
        setAccessToken(token);
        setLoginKey('');
      }
      const result = await requestAivax(AIVAX_RELAYS_URL, {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (!Array.isArray(result?.avis) || result.avis.length > 32 || result.avis.some((device) =>
        !device || typeof device.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(device.deviceId)
        || typeof device.name !== 'string' || device.name.length > 128
        || !Number.isFinite(device.connectedAt) || !Number.isFinite(device.expiresAt)
        || !Number.isInteger(device.consumers) || device.consumers < 0)) throw new Error('Invalid relay response.');
      if (!controller.signal.aborted) {
        setAccessToken(token);
        setDevices(result.avis);
        if (savedToken) setRemoteConnections(result.avis.map((device) => deviceConnection(device, token)));
      }
    } catch (value) {
      if (aivaxRequest.current !== controller) return;
      if (value.status === 401 || value.status === 403) {
        setAccessToken('');
        if (savedToken) {
          setAccountToken('');
          setRemoteConnections([]);
          await saveAivaxAccessToken('').catch(() => {});
        }
      }
      setAivaxError(controller.signal.aborted ? 'Request timed out. Please try again.' : value.status ? value.message : 'Could not load connected devices. Please try again.');
    } finally {
      clearTimeout(timer);
      if (aivaxRequest.current === controller) {
        aivaxRequest.current = null;
        setAivaxBusy(false);
      }
    }
  }
  const deviceConnection = (device, token) => ({ id: `relay:${device.deviceId}`, label: device.name, serverUrl: AIVAX_RELAYS_URL, relay: { deviceId: device.deviceId, accessToken: token } });
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const dialogRef = useRef(null);
  const openerRef = useRef(null);

  const refresh = () => listConnections().then(setConnections).catch((value) => setError(value.message));
  useEffect(refresh, []);
  useEffect(() => { connections.forEach(onCheck); }, [connections]);
  useEffect(() => {
    if (!form) return;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector(window.matchMedia('(pointer: coarse)').matches ? 'button' : 'input')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
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
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    setFormError('');
    try {
      await saveConnection(form);
      closeForm();
      await refresh();
    } catch (value) {
      setFormError(value.message);
      if (value.message.includes('URL')) dialogRef.current?.querySelector('[name="serverUrl"]')?.focus();
    } finally { submitting.current = false; setSaving(false); }
  }

  async function remove(connection) {
    if (!confirm(`Remove “${connection.label}”? The remote Avi data will not be changed.`)) return;
    try { await deleteConnection(connection.id); await refresh(); }
    catch (value) { setError(value.message); }
  }

  return <main class="connections-page">
    <header class="connections-header">
      <div><span class="wordmark"><img src="avi.png" alt="" width="22" height="22" />AVI</span><h1>Connections</h1><p>Remote Avi instances available to this browser.</p></div>
      <div class="connection-actions"><button class="primary" onClick={() => openForm({ ...EMPTY_FORM })}><i class="ri-add-line" /> Add connection</button><button onClick={() => { setAivaxError(''); setAivaxOpen(true); }}><i class="ri-login-box-line" /> {accountToken ? 'AIVAX account' : 'Login with AIVAX'}</button>{accountToken && <button disabled={aivaxBusy} onClick={() => loadDevices(null, accountToken)}>Refresh devices</button>}</div>
    </header>
    {error && <p class="error-banner" role="alert">{error}</p>}
    {!aivaxOpen && aivaxError && <p role="alert" class="error-banner">{aivaxError}</p>}
    {!aivaxOpen && aivaxBusy && <p role="status">Loading connected devices...</p>}
    <section class="connection-grid" aria-label="Configured Avi instances">
      {[...connections, ...remoteConnections].map((connection) => {
        const status = statuses[connection.id] ?? (connection.relay ? { status: 'online', detail: 'Available through your AIVAX account' } : { status: 'checking', detail: 'Checking...' });
        return <article class="connection-card" key={connection.id}>
          <header><div><h2>{connection.label}</h2><code>{connection.serverUrl}</code></div><span class={`connection-status ${status.status}`}><i />{status.status}</span></header>
          <p>{status.detail || (status.status === 'online' ? 'RPC API v1 available' : 'Remote instance unavailable')}</p>
          <footer>
            <button class="primary" disabled={(!connection.relay && status.status !== 'online') || openingId !== null} onClick={() => onEnter(connection, [...connections, ...remoteConnections])}>{openingId === connection.id ? 'Opening...' : 'Open workspace'}</button>
            {!connection.relay && <><button aria-label={`Check ${connection.label}`} title="Check connection" disabled={status.status === 'checking' || openingId !== null} onClick={() => onCheck(connection)}><i class="ri-refresh-line" /></button>
            <button aria-label={`Edit ${connection.label}`} title="Edit connection" onClick={() => openForm({ ...connection })}><i class="ri-pencil-line" /></button>
            <button class="danger-quiet" aria-label={`Remove ${connection.label}`} title="Remove connection" onClick={() => remove(connection)}><i class="ri-delete-bin-line" /></button></>}
          </footer>
        </article>;
      })}
      {connections.length === 0 && remoteConnections.length === 0 && <div class="empty-connections"><i class="ri-links-line" /><h2>No remote instances</h2><p>Add an Avi URL and API key, or link your AIVAX account to list its remote instances automatically.</p></div>}
    </section>
    {aivaxOpen && <div class="modal-backdrop">
      <form ref={aivaxDialogRef} class="connection-dialog" role="dialog" aria-modal="true" aria-label="Login with AIVAX" onSubmit={async (event) => {
        event.preventDefault();
        if (devices === null) return loadDevices(event, accountToken);
        setAivaxBusy(true);
        try {
          await saveAivaxAccessToken(accessToken);
          setAccountToken(accessToken);
          setRemoteConnections(devices.map((device) => deviceConnection(device, accessToken)));
          closeAivax();
        } catch { setAivaxError('Could not save the AIVAX account in this browser.'); }
        finally { setAivaxBusy(false); }
      }}>
        <header><div><h2>{accessToken ? 'Connected Avi devices' : 'Login with AIVAX'}</h2><p>Approve this account to save its access key in this browser and automatically list all remote instances whenever you open Avi Workspace.</p></div><button type="button" aria-label="Close AIVAX" onClick={closeAivax}><i class="ri-close-line" /></button></header>
        {!accessToken && !accountToken && <label>Login key<input type="password" name="loginKey" autoComplete="off" autoCapitalize="none" spellcheck={false} enterKeyHint="go" required value={loginKey} disabled={aivaxBusy} onInput={(event) => setLoginKey(event.currentTarget.value)} /></label>}
        {aivaxError && <p role="alert" class="error-banner">{aivaxError}</p>}
        <div aria-live="polite" aria-busy={aivaxBusy}>
          {aivaxBusy && <p>Loading connected devices...</p>}
          {devices?.length === 0 && <p>No Avi devices are online. Enable the relay in Avi Desktop using the same AIVAX account, then refresh.</p>}
          {devices?.length > 0 && <ul class="aivax-devices">{devices.map((device) => <li key={device.deviceId}><strong>{device.name}</strong><code>{device.deviceId}</code><small>{device.consumers} connected consumers</small></li>)}</ul>}
        </div>
        <footer>{(accessToken || accountToken) && <button type="button" disabled={aivaxBusy} onClick={async () => {
          try {
            await saveAivaxAccessToken('');
            setAccountToken(''); setRemoteConnections([]); setAccessToken(''); setLoginKey(''); setDevices(null); setAivaxError('');
          } catch { setAivaxError('Could not remove the saved AIVAX account.'); }
        }}>Log out</button>}<button type="submit" class="primary" disabled={aivaxBusy || (!accessToken && !accountToken && !loginKey.trim())}>{devices !== null ? 'Approve account' : accountToken || accessToken ? 'Refresh devices' : 'Log in'}</button></footer>
      </form>
    </div>}
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
        <label>Name<input name="label" autoComplete="off" value={form.label} onInput={(event) => setForm({ ...form, label: event.currentTarget.value })} placeholder="Development Avi" /></label>
        <label>Remote Avi URL<input inputMode="url" name="serverUrl" autoComplete="url" autoCapitalize="none" spellcheck={false} required aria-invalid={formError.includes('URL') || undefined} aria-describedby={formError ? 'connection-form-error' : undefined} value={form.serverUrl} onInput={(event) => setForm({ ...form, serverUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:18992" /></label>
        <label>API key<input required type="password" name="apiKey" autoCapitalize="none" spellcheck={false} enterKeyHint="go" aria-describedby={formError ? 'connection-form-error' : undefined} value={form.apiKey} onInput={(event) => setForm({ ...form, apiKey: event.currentTarget.value })} autocomplete="off" /></label>
        {formError && <p id="connection-form-error" class="error-banner" role="alert">{formError}</p>}
        <footer><button type="button" onClick={closeForm}>Cancel</button><button type="submit" class="primary" disabled={saving}>{saving ? 'Saving...' : 'Save connection'}</button></footer>
      </form>
    </div>}
  </main>;
}
