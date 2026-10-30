import { useEffect, useState } from 'preact/hooks';
import { METHODS, supportsMethod } from '../rpc/contracts.js';
import { summarizeThreadStatistics } from '../lib/thread-statistics.js';

export function ThreadStatistics({ client, discovery }) {
  const [statistics, setStatistics] = useState(null);
  const [error, setError] = useState('');
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    if (!supportsMethod(discovery, METHODS.chatStatistics)) return undefined;
    let active = true;
    setError('');
    client.request(METHODS.chatStatistics).then((result) => {
      if (active) setStatistics(result);
    }).catch((failure) => {
      if (active) setError(failure.message || 'Could not read the thread statistics.');
    });
    return () => { active = false; };
  }, [client, discovery, refreshCount]);

  if (!supportsMethod(discovery, METHODS.chatStatistics)) {
    return <p class="panel-empty">This Avi instance does not report thread statistics.</p>;
  }

  return (
    <section class="statistics-list" aria-label="Thread statistics">
      <header>
        <h2>Thread statistics</h2>
        <button type="button" onClick={() => setRefreshCount((current) => current + 1)}><i class="ri-refresh-line" aria-hidden="true" />Refresh</button>
      </header>
      {error && <p class="inline-error" role="alert">{error}</p>}
      {statistics ? summarizeThreadStatistics(statistics).map((row) => (
        <div key={row.id}>
          <span><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</span>
          <b>{row.value}</b>
        </div>
      )) : !error && <p class="panel-empty">Loading statistics…</p>}
    </section>
  );
}