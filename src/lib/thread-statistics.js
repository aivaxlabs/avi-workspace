function compactNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const [divisor, suffix] = value >= 1_000_000 ? [1_000_000, 'M'] : value >= 1_000 ? [1_000, 'K'] : [1, ''];
  const scaled = value / divisor;
  return `${scaled.toFixed(divisor === 1 || scaled >= 100 ? 0 : 1).replace(/\.0$/, '')}${suffix}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  return milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(1)} s` : `${Math.round(milliseconds)} ms`;
}

function formatPercentiles(percentiles, format) {
  if (!percentiles?.samples) return '—';
  return `${format(percentiles.p50)} · p95 ${format(percentiles.p95)}`;
}

function formatRatio(ratio) {
  return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : null;
}

export function summarizeThreadStatistics(statistics = {}) {
  const tokens = statistics.tokens ?? {};
  const requests = statistics.requests ?? {};
  const tools = statistics.tools ?? {};
  const tokenDetails = [
    `in ${compactNumber(tokens.input ?? 0)}`,
    `out ${compactNumber(tokens.output ?? 0)}`,
    formatRatio(tokens.cachedRatio) && `cached ${formatRatio(tokens.cachedRatio)}`,
    formatRatio(tokens.reasoningRatio) && `reasoning ${formatRatio(tokens.reasoningRatio)}`,
  ].filter(Boolean);
  const failedTools = (tools.invocationErrors ?? 0) + (tools.otherErrors ?? 0);
  return [
    { id: 'first-token', label: 'First token', value: formatPercentiles(statistics.latency?.firstToken, formatDuration), detail: null },
    { id: 'connection', label: 'Connection', value: formatPercentiles(statistics.latency?.connection, formatDuration), detail: null },
    { id: 'speed', label: 'Output speed', value: formatPercentiles(statistics.tokensPerSecond, (value) => `${compactNumber(value)} tok/s`), detail: null },
    { id: 'tokens', label: 'Tokens', value: compactNumber(tokens.total ?? 0), detail: tokenDetails.join(' · ') },
    { id: 'requests', label: 'Requests', value: compactNumber(requests.count ?? 0), detail: `${compactNumber(requests.errors ?? 0)} failed` },
    { id: 'tools', label: 'Tool calls', value: compactNumber(tools.calls ?? 0), detail: `${compactNumber(failedTools)} failed` },
  ];
}