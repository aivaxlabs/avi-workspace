import { useEffect, useMemo, useState } from 'preact/hooks';
import { renderMarkdown } from '../lib/markdown.js';
import { buildMessageTimeline, formatWorkedDuration, operationGroupHasTools, operationGroupLabel, partitionMessageTimeline } from '../lib/message-timeline.js';
import { attachmentReadParams, METHODS, normalizeAttachmentChunk } from '../rpc/contracts.js';

function Attachment({ attachment, messageId, client, assistant }) {
  const [url, setUrl] = useState('');
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const name = attachment.name ?? attachment.path ?? 'Attachment';
  const mime = attachment.mime ?? attachment.mimeType ?? '';
  const image = attachment.kind === 'image_url' || mime.startsWith('image/');
  const video = attachment.kind === 'video_url' || mime.startsWith('video/');
  const contextMarker = attachment.kind === 'context_marker';
  const size = Number(attachment.size);
  const sizeLabel = Number.isFinite(size) && size > 0
    ? size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`
    : '';
  const icon = contextMarker
    ? attachment.markerType === 'workflow'
      ? 'ri-flow-chart'
      : attachment.markerType === 'work_item'
        ? 'ri-list-check-3'
        : attachment.markerType === 'directory_reference'
          ? 'ri-folder-line'
          : attachment.markerType?.startsWith('file_')
            ? 'ri-file-text-line'
            : 'ri-sparkling-line'
    : image
      ? 'ri-image-line'
      : video
        ? 'ri-video-line'
        : mime.startsWith('audio/')
          ? 'ri-file-music-line'
          : mime === 'application/pdf'
            ? 'ri-file-pdf-2-line'
            : 'ri-file-line';

  useEffect(() => () => url && URL.revokeObjectURL(url), [url]);
  useEffect(() => {
    if (!lightboxOpen) return undefined;
    const close = (event) => event.key === 'Escape' && setLightboxOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [lightboxOpen]);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const chunks = [];
      let offset = 0;
      let metadata;
      do {
        metadata = normalizeAttachmentChunk(await client.request(METHODS.readAttachment, attachmentReadParams({ messageId, attachmentId: attachment.id }, offset)));
        chunks.push(Uint8Array.from(atob(metadata.data), (character) => character.charCodeAt(0)));
        offset = metadata.cursor ?? offset + chunks.at(-1).length;
      } while (metadata.hasMore);
      setUrl(URL.createObjectURL(new Blob(chunks, { type: metadata.mime })));
    } catch (value) {
      setError(value.message);
    } finally {
      setLoading(false);
    }
  }

  if (image) {
    return <>
      <button class={`user-attachment-image${assistant ? ' assistant-attachment-image' : ''}${url ? '' : ' attachment-placeholder'}`} type="button" aria-label={`${url ? 'Open' : 'Load preview for'} ${name}`} title={name} disabled={loading} onClick={() => url ? setLightboxOpen(true) : load()}>
        {url ? <img src={url} alt={name} /> : <><i class={loading ? 'ri-loader-4-line spinning' : icon} aria-hidden="true" /><span>{loading ? 'Loading' : 'Load'}</span></>}
      </button>
      {error && <small class="attachment-error" role="alert">Unavailable: {error}</small>}
      {lightboxOpen && <div class="attachment-lightbox" role="dialog" aria-modal="true" aria-label={`Image preview: ${name}`} onMouseDown={(event) => event.target === event.currentTarget && setLightboxOpen(false)}>
        <img src={url} alt={name} />
        <button type="button" aria-label="Close image preview" title="Close" onClick={() => setLightboxOpen(false)}><i class="ri-close-line" /></button>
      </div>}
    </>;
  }

  if (video) {
    return <div class="user-attachment-video" title={name}>
      {url ? <video controls preload="metadata" src={url} /> : <button type="button" aria-label={`Load preview for ${name}`} disabled={loading} onClick={load}><i class={loading ? 'ri-loader-4-line spinning' : icon} /><span>{loading ? 'Loading preview' : 'Load preview'}</span></button>}
      {error && <small class="attachment-error" role="alert">Unavailable: {error}</small>}
    </div>;
  }

  return <div class={`attachment-file${diff ? ' expanded' : ''}`}>
    <div class={`attachment-pill${contextMarker ? ' context-marker' : ''}`}>
      <i class={icon} aria-hidden="true" />
      <span class="attachment-name" title={name}>{name}</span>
      {!contextMarker && sizeLabel && <small>{sizeLabel}</small>}
      {attachment.kind === 'file_reference' && attachment.path && <button type="button" aria-label={`View diff for ${name}`} title="View diff" onClick={() => client.request(METHODS.filesDiff, { filePath: attachment.path }).then((result) => setDiff(result.diff ?? result.content ?? '')).catch((value) => setError(value.message))}><i class="ri-file-diff-line" /></button>}
      {!contextMarker && (url
        ? <a href={url} download={name} aria-label={`Download ${name}`} title="Download"><i class="ri-download-line" /></a>
        : <button type="button" aria-label={`Load ${name}`} title="Load from Avi" disabled={loading} onClick={load}><i class={loading ? 'ri-loader-4-line spinning' : 'ri-download-cloud-2-line'} /></button>)}
    </div>
    {diff && <DiffBlock segment={{ diff }} />}
    {error && <small class="attachment-error" role="alert">Unavailable: {error}</small>}
  </div>;
}

function AttachmentList({ attachments, messageId, client, assistant = false }) {
  if (!attachments.length) return null;
  return <div class={`attachment-list user-attachment-list${assistant ? ' assistant-attachment-list' : ''}`} aria-label="Message attachments">
    {attachments.map((attachment) => <Attachment key={attachment.id ?? attachment.path} attachment={attachment} messageId={messageId} client={client} assistant={assistant} />)}
  </div>;
}

function DiffBlock({ segment }) {
  const lines = String(segment.diff ?? segment.content ?? '').split('\n').map((line, position) => ({ id: `${position}:${line}`, line }));
  return <pre class="diff-block" aria-label="File diff">{lines.map(({ id, line }) => <span key={id} class={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}>{line}</span>)}</pre>;
}

function MarkdownBlock({ text, muted = false }) {
  return <div class={muted ? 'markdown reasoning-text' : 'markdown'} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function ToolEntry({ segment, client }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [detailsError, setDetailsError] = useState('');
  const name = segment.name ?? segment.toolName ?? segment.toolType ?? 'tool';
  const hasResult = segment.hasResult ?? Object.hasOwn(segment, 'resultText');
  const reason = segment.invocationGoal ?? segment.reason ?? '';

  useEffect(() => {
    if (!open || !segment.detailsAvailable || details?.hasResult === hasResult) return undefined;
    let active = true;
    setDetails(null);
    setDetailsError('');
    client.request(METHODS.toolCallDetails, {
      messageId: segment.messageId,
      segmentId: segment.id,
    }).then((result) => {
      if (active) setDetails(result);
    }).catch((error) => {
      if (active) setDetailsError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [client, details?.hasResult, hasResult, open, segment.detailsAvailable, segment.id, segment.messageId]);

  const input = useMemo(() => {
    const value = String(details?.argumentsText ?? segment.argumentsText ?? '');
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }, [details?.argumentsText, segment.argumentsText]);
  const detailHasResult = details?.hasResult ?? hasResult;
  const output = useMemo(() => {
    const value = String(details?.resultText ?? segment.resultText ?? segment.content ?? '');
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }, [details?.resultText, segment.resultText, segment.content]);
  const loadingDetails = segment.detailsAvailable && !details && !detailsError;

  return <div class={`tool-entry ${open ? 'open' : ''} ${segment.status === 'error' ? 'error' : ''}`}>
    <button type="button" class="tool-line" aria-expanded={open} onClick={() => setOpen(!open)}>
      {!hasResult && <i class="ri-loader-4-line spinning" aria-label="Waiting for tool output" />}
      <i class={name.startsWith('mcp_') || segment.isMcp ? 'ri-function-line' : 'ri-terminal-box-line'} aria-hidden="true" />
      <span><strong>{name}</strong>{reason && <span class={!hasResult ? 'tool-line-pending-text' : ''}> {reason}</span>}</span>
      <i class="ri-arrow-right-s-line tool-line-chevron" aria-hidden="true" />
    </button>
    {open && <div class="tool-details">
      {loadingDetails
        ? <span role="status">Loading tool details...</span>
        : detailsError
          ? <span role="alert">Could not load tool details: {detailsError}</span>
          : <>
            <section><span>Input</span><pre><code>{input || '(empty input)'}</code></pre></section>
            <section><span>Output</span><pre><code>{detailHasResult ? output || '(empty output)' : '(waiting for output)'}</code></pre></section>
          </>}
    </div>}
  </div>;
}

function OperationsGroup({ items, client, streaming = false, trailing = false }) {
  const [manualOpen, setManualOpen] = useState(null);
  const open = manualOpen ?? (streaming && trailing);
  const visibleItems = items.filter((item) => item.name !== 'ask_question');
  if (!visibleItems.length) return null;
  const label = operationGroupLabel(visibleItems);
  const hasTools = operationGroupHasTools(visibleItems);
  return <div class={`thinking-group ${hasTools ? 'has-tools' : ''} ${open ? 'open' : ''}`}>
    <button type="button" class="thinking-summary" aria-expanded={open} onClick={() => setManualOpen(!open)}>
      <span>{label}</span><i class={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} aria-hidden="true" />
    </button>
    {open && <div class="thinking-details"><div class="thinking-details-inner">
      {visibleItems.map((item) => item.type === 'reasoning'
        ? <div class="reasoning-entry" key={item.id ?? `reasoning:${item.text ?? item.content}`}><i class="ri-brain-line" aria-hidden="true" /><MarkdownBlock text={String(item.text ?? item.content ?? '')} muted /></div>
        : item.type === 'tool-call'
          ? <ToolEntry key={item.id ?? item.callId ?? `tool:${item.name}:${item.argumentsText}`} segment={item} client={client} />
          : item.type === 'error'
            ? <div class="error-line" key={item.id ?? `error:${item.message ?? item.content}`}>{item.message ?? item.content}</div>
            : null)}
    </div></div>}
  </div>;
}

function TimelineItems({ items, client, streaming = false }) {
  return <>{items.map((item, index) => item.type === 'content'
    ? <MarkdownBlock key={item.id ?? `content:${item.text}`} text={item.text} />
    : item.type === 'operations'
      ? <OperationsGroup key={item.id ?? `operations:${item.items.map((entry) => entry.id ?? entry.callId ?? entry.type).join(':')}`} items={item.items} client={client} streaming={streaming} trailing={index === items.length - 1} />
      : item.type === 'diff'
        ? <DiffBlock key={item.segment.id ?? `diff:${item.segment.diff}`} segment={item.segment} />
        : <section key={item.segment?.id ?? `segment:${item.segment?.type}:${item.segment?.content}`} class={`rich-segment ${item.segment?.type ?? ''}`}>{item.segment?.content && <MarkdownBlock text={String(item.segment.content)} />}</section>)}</>;
}

function WorkedBlock({ items, message, client }) {
  const [open, setOpen] = useState(false);
  return <div class={`worked-block ${open ? 'open' : ''}`}>
    <button type="button" class="worked-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{formatWorkedDuration(message.createdAt, message.updatedAt)}</span><i class={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} aria-hidden="true" />
    </button>
    {open && <div class="worked-details"><div class="worked-details-inner"><TimelineItems items={items} client={client} /></div></div>}
  </div>;
}

export function RichMessage({ message, client }) {
  const user = message.role === 'user';
  const timeline = useMemo(() => buildMessageTimeline(message), [message]);
  const streaming = message.status === 'streaming';
  const { workedItems, finalItems } = useMemo(() => partitionMessageTimeline(timeline, streaming), [timeline, streaming]);

  if (user) {
    return <article class={`message user ${message.status ?? ''}`} data-message-id={message.id}>
      <div class="user-message-content">
        {message.content && <div class="user-bubble"><div class="user-text">{message.content}</div></div>}
        <AttachmentList attachments={message.attachments ?? []} messageId={message.id} client={client} />
      </div>
    </article>;
  }

  return <article class={`message assistant ${message.status ?? ''}`} data-message-id={message.id}>
    <div class="assistant-timeline">
      {workedItems.length > 0 && <WorkedBlock items={workedItems} message={message} client={client} />}
      <TimelineItems items={finalItems} client={client} streaming={streaming} />
    </div>
    <AttachmentList attachments={message.attachments ?? []} messageId={message.id} client={client} assistant />
    {streaming && <div class="assistant-placeholder" aria-live="polite">Thinking</div>}
    {message.status && !['completed', 'sent', 'streaming'].includes(message.status) && <footer class="message-status">{message.status}</footer>}
  </article>;
}
