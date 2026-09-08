import { useEffect, useId, useMemo, useState } from 'preact/hooks';
import { Fragment, jsx, jsxs } from 'preact/jsx-runtime';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import DOMPurify from 'dompurify';
import { remarkAviDirectives } from '../lib/markdown-directives.js';

const directiveProperties = {
  'avi-callout': ['kind', 'title'],
  'avi-finding': ['level', 'title'],
  'avi-chart': ['chartType', 'title', 'chartData'],
  'avi-copy': ['label', 'value'],
  'avi-diff': ['source', 'title'],
  'avi-mermaid': ['source'],
  'avi-latex': ['source', 'displayMode'],
  'avi-fileref': ['path', 'lineFrom', 'lineTo'],
  'avi-file-mention': ['path', 'lineFrom', 'lineTo', 'language', 'value'],
};
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks).use(remarkDirective)
  .use(remarkAviDirectives).use(remarkRehype).use(rehypeSanitize, {
    ...defaultSchema,
    tagNames: [...defaultSchema.tagNames, ...Object.keys(directiveProperties)],
    attributes: { ...defaultSchema.attributes, ...directiveProperties },
  });

function CopyPanel({ label, value, children }) {
  const [status, setStatus] = useState('');
  return <section class="visual-panel" aria-label={label}>
    <header><span>{label}</span><button type="button" aria-label={`Copy ${label}`} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setStatus('Copied'); }
      catch { setStatus('Could not copy. Select the text and copy manually.'); }
    }}>Copy</button></header>
    {children ?? <pre>{value}</pre>}
    {status && <small role="status">{status}</small>}
  </section>;
}

function AsyncVisualization({ source, displayMode, kind }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [result, setResult] = useState(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    void (async () => {
      try {
        let output;
        if (kind === 'mermaid') {
          if (/%%\s*\{|^\s*---|\b(?:click|href|https?|javascript|data):?|<\/?[a-z]/im.test(source)) throw new Error('Unsupported diagram content');
          const { default: mermaid } = await import('mermaid');
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 20_000, suppressErrorRendering: true });
          const rendered = await mermaid.render(`workspace-diagram-${id}`, source);
          const svg = DOMPurify.sanitize(rendered.svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject', 'script', 'image', 'a'],
            FORBID_ATTR: ['href', 'xlink:href'],
          });
          output = { image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
        } else {
          const { default: katex } = await import('katex');
          output = { html: katex.renderToString(source, { displayMode: Boolean(displayMode), output: 'mathml', throwOnError: true, trust: false, strict: 'error', maxExpand: 1000, maxSize: 20 }) };
        }
        if (active) setResult({ ...output, source });
      } catch {
        if (active) setResult({ error: true, source });
      }
    })();
    return () => { active = false; };
  }, [source, displayMode, kind, id]);
  const current = result?.source === source ? result : null;
  const label = kind === 'mermaid' ? 'Mermaid diagram' : 'LaTeX equation';
  return <section class="visual-async" aria-label={label}>
    {current?.image ? <img src={current.image} alt={label} />
      : current?.html ? <div dangerouslySetInnerHTML={{ __html: current.html }} />
        : <><small role="status">{current?.error ? `${label} could not be rendered` : `Rendering ${label}...`}</small><pre>{source}</pre></>}
  </section>;
}

const components = {
  'avi-callout': ({ kind, title, children }) => <h3 class={`visual-heading callout-${kind}`}><i class={{ info: 'ri-information-line', success: 'ri-checkbox-circle-line', warning: 'ri-alert-line', danger: 'ri-error-warning-line' }[kind]} aria-hidden="true" />{children?.length ? children : title}</h3>,
  'avi-finding': ({ level, title, children }) => <h3 class={`visual-heading finding-${level}`}><strong>{level}</strong>{children?.length ? children : title}</h3>,
  'avi-copy': ({ label, value }) => <CopyPanel label={label} value={value} />,
  'avi-fileref': ({ path, lineFrom, lineTo }) => <span class="visual-file-ref" title="Workspace file reference; host files cannot be opened from this client"><i class="ri-file-code-line" aria-hidden="true" /><code>{path}{lineFrom ? `:${lineFrom}${lineTo && lineTo !== lineFrom ? `–${lineTo}` : ''}` : ''}</code></span>,
  'avi-file-mention': ({ path, lineFrom, lineTo, value, children }) => <CopyPanel label={`${path}${lineFrom ? `:${lineFrom}${lineTo && lineTo !== lineFrom ? `–${lineTo}` : ''}` : ''}`} value={value}><div class="visual-file-content">{children}</div></CopyPanel>,
  'avi-diff': ({ source, title }) => <CopyPanel label={title} value={source}><pre class="visual-diff"><code>{source.split('\n').map((line, index) => <span key={index} class={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}>{line}{'\n'}</span>)}</code></pre></CopyPanel>,
  'avi-mermaid': ({ source }) => <AsyncVisualization source={source} kind="mermaid" />,
  'avi-latex': ({ source, displayMode }) => <AsyncVisualization source={source} displayMode={displayMode} kind="latex" />,
  'avi-chart': ({ chartType, title, chartData }) => {
    const data = JSON.parse(chartData);
    const max = Math.max(...data.map((item) => item.value), 1);
    const scaledTotal = data.reduce((sum, item) => sum + item.value / max, 0);
    let offset = 0;
    return <figure class={`visual-chart chart-${chartType}`} aria-label={title}>
      <figcaption>{title}</figcaption>
      {chartType === 'line' && <svg viewBox="0 0 640 220" role="img" aria-label="Line chart">
        <polyline points={data.map((item, index) => `${data.length === 1 ? 320 : 24 + index / (data.length - 1) * 592},${196 - item.value / max * 172}`).join(' ')} />
        {data.map((item, index) => <circle key={item.label} cx={data.length === 1 ? 320 : 24 + index / (data.length - 1) * 592} cy={196 - item.value / max * 172} r="4"><title>{item.label}: {item.value}</title></circle>)}
      </svg>}
      {chartType === 'pie' && <svg class="visual-pie" viewBox="0 0 100 100" role="img" aria-label="Pie chart">
        <circle class="pie-empty" cx="50" cy="50" r="40" />
        {data.map((item, index) => {
          const fraction = scaledTotal ? (item.value / max) / scaledTotal : 0;
          const start = offset;
          offset += fraction;
          return <circle key={item.label} class={`series-${index % 6}`} cx="50" cy="50" r="40" pathLength="1" stroke-dasharray={`${fraction} ${1 - fraction}`} stroke-dashoffset={-start} transform="rotate(-90 50 50)"><title>{item.label}: {item.value}</title></circle>;
        })}
      </svg>}
      <ul>{data.map((item, index) => <li key={item.label}>
        <span>{chartType === 'pie' && <i class={`series-${index % 6}`} aria-hidden="true" />}{item.label}</span>
        {(chartType === 'bar' || chartType === 'progress') && <progress aria-label={item.label} value={item.value} max={chartType === 'progress' ? item.max : max} />}
        <strong>{item.value}{chartType === 'progress' ? ` / ${item.max}` : ''}</strong>
      </li>)}</ul>
    </figure>;
  },
};

export function ChatMarkdown({ text, muted = false }) {
  const content = useMemo(() => {
    const source = String(text ?? '');
    const tree = processor.runSync(processor.parse(source), { value: source });
    return toJsxRuntime(tree, { Fragment, jsx, jsxs, components });
  }, [text]);
  return <div class={muted ? 'markdown reasoning-text' : 'markdown'}>{content}</div>;
}
