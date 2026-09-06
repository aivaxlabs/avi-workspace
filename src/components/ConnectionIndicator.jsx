import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { DialogShell } from './SidebarDialogs.jsx';

export function ConnectionIndicator({ globalClient, conversationClient, status, switching }) {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState(null);
  useEffect(() => {
    let previous = null;
    const timer = setInterval(() => {
      const clients = [globalClient, conversationClient].filter(Boolean);
      const sentBytes = clients.reduce((total, client) => total + (client.metrics?.sentBytes ?? 0), 0);
      const receivedBytes = clients.reduce((total, client) => total + (client.metrics?.receivedBytes ?? 0), 0);
      const now = performance.now();
      const seconds = previous ? (now - previous.now) / 1000 : 0;
      setSample({
        upload: seconds ? Math.max(0, sentBytes - previous.sentBytes) / seconds : null,
        download: seconds ? Math.max(0, receivedBytes - previous.receivedBytes) / seconds : null,
        sentBytes, receivedBytes,
      });
      previous = { now, sentBytes, receivedBytes };
    }, 1000);
    setSample(null);
    return () => clearInterval(timer);
  }, [globalClient, conversationClient]);

  const state = switching ? 'checking' : status?.status ?? 'offline';
  const clients = [globalClient, conversationClient].filter(Boolean);
  const completed = clients.reduce((total, client) => total + (client.metrics?.completed ?? 0), 0);
  const failed = clients.reduce((total, client) => total + (client.metrics?.failed ?? 0), 0);
  const reconnects = clients.reduce((total, client) => total + (client.metrics?.reconnects ?? 0), 0);
  const latest = clients.map((client) => client.metrics).filter((metrics) => metrics?.lastResponseAt).sort((a, b) => b.lastResponseAt - a.lastResponseAt)[0];
  const measured = clients.map((client) => client.metrics).filter((metrics) => metrics?.completed > 0);
  const latencyMin = Math.min(...measured.map((metrics) => metrics.latencyMinMs));
  const latencyMax = Math.max(...measured.map((metrics) => metrics.latencyMaxMs));
  const latencyAvg = measured.reduce((total, metrics) => total + metrics.latencyTotalMs, 0) / completed;
  const stale = !latest || Date.now() - latest.lastResponseAt > 30_000;
  const slow = !stale && latest.latencyMs > 2000;
  const icon = state !== 'online' ? 'ri-signal-wifi-off-line' : stale || slow ? 'ri-wifi-line' : 'ri-signal-wifi-fill';
  const label = `Connection details: ${switching ? 'switching instance' : state}`;
  return <>
    <button type="button" class={`connection-indicator ${state}${slow ? ' slow' : ''}`} aria-label={label} title={label} aria-haspopup="dialog" onClick={() => setOpen(true)}><i class={icon} aria-hidden="true" /></button>
    {open && createPortal(<DialogShell title="Connection details" onClose={() => setOpen(false)}>
      <div class="connection-details">
        <p class="connection-summary"><strong>{switching ? 'Switching instance' : state === 'online' ? slow ? 'Connected · slow response' : 'Connected' : state === 'checking' ? 'Connecting' : 'Disconnected'}</strong><span>{globalClient?.relay ? 'Via Avi Relay' : 'Direct WebSocket'} · ORPC/1</span></p>
        {status?.error && <p role="alert">{status.error}</p>}
        <dl>
          <div><dt>Round trip (min / avg / max)</dt><dd>{completed > 0 ? `${Math.round(latencyMin)} / ${Math.round(latencyAvg)} / ${Math.round(latencyMax)} ms${stale ? ' (stale)' : ''}` : 'Waiting for a response'}</dd></div>
          <div><dt>Download</dt><dd>{sample?.download == null ? 'Measuring...' : `${(sample.download / 1024).toFixed(1)} KiB/s`}</dd></div>
          <div><dt>Upload</dt><dd>{sample?.upload == null ? 'Measuring...' : `${(sample.upload / 1024).toFixed(1)} KiB/s`}</dd></div>
          <div><dt>Received / sent</dt><dd>{((sample?.receivedBytes ?? 0) / 1024).toFixed(1)} / {((sample?.sentBytes ?? 0) / 1024).toFixed(1)} KiB</dd></div>
          <div><dt>Failed calls</dt><dd>{failed} / {completed + failed}{completed + failed > 0 ? ` (${(failed / (completed + failed) * 100).toFixed(1)}%)` : ''}</dd></div>
          <div><dt>Reconnections</dt><dd>{reconnects}</dd></div>
          <div><dt>Global / conversation channel</dt><dd>{globalClient?.socket?.readyState === 1 ? 'Online' : 'Offline'} / {conversationClient ? conversationClient.socket?.readyState === 1 ? 'Online' : 'Offline' : 'Not open'}</dd></div>
        </dl>
        <p class="connection-note">Round trip includes server processing, queueing and any recovery. Transfer rates measure ORPC traffic, not your internet connection’s maximum speed. TCP packet loss cannot be inferred from failed calls.</p>
        <p class="connection-note">Updates every second. Counters cover the current global and conversation clients; selecting another conversation resets that channel’s counters. No speed test or extra requests are sent.</p>
      </div>
    </DialogShell>, document.body)}
  </>;
}
