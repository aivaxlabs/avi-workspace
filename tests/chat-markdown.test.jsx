import { afterEach, beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'preact/test-utils';
import { h, render } from 'preact';

const window = new Window({ url: 'http://localhost/' });
window.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node });
let ChatMarkdown;
let root;
beforeAll(async () => { ({ ChatMarkdown } = await import('../src/components/ChatMarkdown.jsx')); });
afterEach(() => { if (root) act(() => render(null, root)); document.body.replaceChildren(); });

function show(text) {
  if (!root?.isConnected) { root = document.createElement('div'); document.body.append(root); }
  act(() => render(h(ChatMarkdown, { text }), root));
  return root;
}

test('renders headings, copyable content, file references and diffs', async () => {
  show('::callout[Keep **backups**]{kind="warning"}\n\n::finding[Unsafe input]{level="P1"}\n\n::avi-copy{label="Command" value="bun test"}\n\nSee :fileref{path="./src/App.jsx" line-from="2" line-to="4"}.\n\n:::avi-diff{title="Change"}\n```diff\n-old\n+new\n```\n:::\n\n:::avi-file-mention{path="./src/App.jsx"}\n**Excerpt**\n:::');
  expect(root.querySelector('.callout-warning strong').textContent).toBe('backups');
  expect(root.querySelector('.finding-P1').textContent).toContain('P1');
  expect(root.querySelector('.visual-file-ref').textContent).toContain('./src/App.jsx:2–4');
  expect(root.querySelector('.visual-diff .added').textContent).toContain('+new');
  expect(root.querySelector('.visual-file-content strong').textContent).toBe('Excerpt');
  const original = navigator.clipboard.writeText;
  const copied = [];
  try {
    navigator.clipboard.writeText = async (text) => copied.push(text);
    await act(async () => root.querySelector('[aria-label="Copy Command"]').click());
    expect(copied).toEqual(['bun test']);
    expect(root.querySelector('[role="status"]').textContent).toBe('Copied');
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    await act(async () => root.querySelector('[aria-label="Copy Command"]').click());
    expect(root.querySelector('[role="status"]').textContent).toContain('Could not copy');
  } finally { navigator.clipboard.writeText = original; }
});

test('renders all chart types with accessible values', () => {
  for (const type of ['bar', 'line', 'pie', 'progress']) {
    show(`::avi-chart{type="${type}" title="Counts" data='[{"label":"A","value":2,"max":4},{"label":"B","value":1,"max":4}]'}`);
    expect(root.querySelector('figure').getAttribute('aria-label')).toBe('Counts');
    expect(root.querySelectorAll('li').length).toBe(2);
    if (type === 'line' || type === 'pie') expect(root.querySelector('svg')).not.toBeNull();
    else expect(root.querySelector('progress').value).toBe(2);
  }
});

test('keeps invalid, incomplete and fenced directives literal, then renders completed streams', () => {
  for (const text of [
    '::avi-chart{type="bar" data=\'[{"label":"A","value":-1}]\'}',
    '::avi-chart{type="bar" data=\'[{"label":"A","value":1},{"label":"A","value":2}]\'}',
    '::finding[Bad]{level="P9"}',
    ':fileref{path="/etc/passwd"}',
    ':fileref{path="./file" line-from="4" line-to="2"}',
    '```markdown\n::callout[Literal]{kind="info"}\n```',
    ':::avi-diff\n```diff\n-old\n+new\n```',
  ]) {
    show(text);
    expect(root.querySelector('figure, .visual-heading, .visual-panel, .visual-file-ref')).toBeNull();
    expect(root.textContent).toContain(text.includes('fileref') ? 'fileref' : text.includes('avi-chart') ? 'avi-chart' : text.includes('finding') ? 'finding' : text.includes('callout') ? 'callout' : 'avi-diff');
  }
  show(':::avi-diff\n```diff\n-old\n+new\n```\n:::');
  expect(root.querySelector('.visual-diff')).not.toBeNull();
});

test('does not turn HTML, URLs or directive attributes into executable elements', () => {
  show('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[bad](javascript:alert%281%29)\n\n::avi-copy{label="Safe" value="<img onerror=alert(1)>" onclick="alert(1)"}\n\n::callout[Safe]{kind="info" style="color:red"}');
  expect(root.querySelector('script, img, [onclick], [onerror], [style], [href^="javascript:"]')).toBeNull();
  expect(root.querySelector('.visual-panel pre').textContent).toBe('<img onerror=alert(1)>');
});

test('renders local MathML and rejects invalid equations', async () => {
  await import('katex');
  show('::latex[E = mc^2]');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(root.querySelector('math')).not.toBeNull();
  expect(root.querySelector('[style]')).toBeNull();
  show('::latex[\\\\unknowncommand{x}]');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(root.querySelector('math')).toBeNull();
  expect(root.querySelector('.visual-async').textContent).toContain('could not be rendered');
});

test('blocked Mermaid content falls back to source without rendering HTML', async () => {
  show(':::mermaid-diagram\n```mermaid\nflowchart LR\nA-->B\nclick A "https://example.com"\n```\n:::');
  await act(async () => { await Promise.resolve(); });
  expect(root.querySelector('.visual-async').textContent).toContain('could not be rendered');
  expect(root.querySelector('img, a')).toBeNull();
});
