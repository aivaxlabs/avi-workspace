import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { renderMarkdown } from '../lib/markdown.js';
import { useModalFocus } from '../lib/use-modal-focus.js';
import { buildMessageTimeline, formatWorkedDuration, operationGroupHasTools, operationGroupLabel, parseStructuredAgentMessage, partitionMessageTimeline } from '../lib/message-timeline.js';
import { attachmentReadParams, METHODS, normalizeAttachmentChunk, supportsMethod } from '../rpc/contracts.js';

const ATTACHMENT_TOTAL_LIMIT = 25 * 1024 ** 2;

function formatByteSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function Attachment({ attachment, messageId, client, discovery, assistant }) {
  const [url, setUrl] = useState('');
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const lightboxRef = useRef(null);
  const readRef = useRef(null);
  const aliveRef = useRef(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const name = attachment.name ?? attachment.path ?? 'Attachment';
  const mime = attachment.mime ?? attachment.mimeType ?? '';
  const image = attachment.kind === 'image_url' || mime.startsWith('image/');
  const video = attachment.kind === 'video_url' || mime.startsWith('video/');
  const contextMarker = attachment.kind === 'context_marker';
  const size = Number(attachment.size);
  const sizeLabel = Number.isFinite(size) && size > 0 ? formatByteSize(size) : '';
  const readSupported = supportsMethod(discovery, METHODS.readAttachment);
  const diffSupported = supportsMethod(discovery, METHODS.filesDiff);
  const blockedReason = !readSupported
    ? 'Attachment loading is not available on this Avi instance.'
    : Number.isFinite(size) && size > ATTACHMENT_TOTAL_LIMIT
      ? 'Attachment exceeds the 25 MiB remote load limit.'
      : '';
  const loading = loaded !== null;
  const progressLabel = loading ? `${formatByteSize(loaded)}${sizeLabel ? ` / ${sizeLabel}` : ''}` : '';
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
  useEffect(() => () => { aliveRef.current = false; if (readRef.current) readRef.current.active = false; }, []);
  useModalFocus({ containerRef: lightboxRef, open: lightboxOpen, onClose: () => setLightboxOpen(false) });

  function cancel() {
    if (readRef.current) readRef.current.active = false;
    readRef.current = null;
    setLoaded(null);
  }

  async function load() {
    if (blockedReason || readRef.current) return;
    const session = { active: true };
    readRef.current = session;
    setError('');
    setLoaded(0);
    try {
      const chunks = [];
      let offset = 0;
      let total = 0;
      let metadata;
      do {
        if (!session.active) return;
        metadata = normalizeAttachmentChunk(await client.request(METHODS.readAttachment, attachmentReadParams({ messageId, attachmentId: attachment.id }, offset)));
        if (!session.active) return;
        if (metadata.data.length > Math.ceil((ATTACHMENT_TOTAL_LIMIT - total) / 3) * 4) throw new Error('Attachment exceeds the 25 MiB remote load limit.');
        const bytes = Uint8Array.from(atob(metadata.data), (character) => character.charCodeAt(0));
        total += bytes.length;
        if (total > ATTACHMENT_TOTAL_LIMIT) throw new Error('Attachment exceeds the 25 MiB remote load limit.');
        if (metadata.hasMore && !bytes.length) throw new Error('Avi returned an empty attachment chunk.');
        chunks.push(bytes);
        setLoaded(total);
        if (!metadata.hasMore) break;
        const nextOffset = metadata.cursor ?? offset + bytes.length;
        if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + bytes.length) throw new Error('Avi attachment cursor did not advance correctly.');
        offset = nextOffset;
        if (offset > ATTACHMENT_TOTAL_LIMIT) throw new Error('Attachment exceeds the 25 MiB remote load limit.');
      } while (true);
      if (!session.active) return;
      setUrl(URL.createObjectURL(new Blob(chunks, { type: metadata.mime })));
    } catch (value) {
      if (session.active) setError(value.message);
    } finally {
      if (readRef.current === session) {
        readRef.current = null;
        setLoaded(null);
      }
    }
  }

  if (image) {
    return <>
      <button class={`user-attachment-image${assistant ? ' assistant-attachment-image' : ''}${url ? '' : ' attachment-placeholder'}`} type="button" aria-label={`${url ? 'Open' : 'Load preview for'} ${name}`} title={blockedReason || name} disabled={loading || Boolean(blockedReason)} onClick={() => url ? setLightboxOpen(true) : load()}>
        {url ? <img src={url} alt={name} /> : <><i class={loading ? 'ri-loader-4-line spinning' : icon} aria-hidden="true" /><span>{loading ? progressLabel : 'Load'}</span></>}
      </button>
      {loading && <div class="attachment-progress" role="status">
        <small>{progressLabel}</small>
        <button type="button" class="attachment-cancel" aria-label={`Cancel loading ${name}`} title="Cancel" onClick={cancel}><i class="ri-close-line" aria-hidden="true" /></button>
      </div>}
      {error && <small class="attachment-error" role="alert">Unavailable: {error}</small>}
      {lightboxOpen && <div class="attachment-lightbox" role="dialog" aria-modal="true" aria-label={`Image preview: ${name}`} ref={lightboxRef} onMouseDown={(event) => event.target === event.currentTarget && setLightboxOpen(false)}>
        <img src={url} alt={name} />
        <button type="button" aria-label="Close image preview" title="Close" onClick={() => setLightboxOpen(false)}><i class="ri-close-line" /></button>
      </div>}
    </>;
  }

  if (video) {
    return <div class="user-attachment-video" title={name}>
      {url ? <video controls preload="metadata" src={url} /> : <button type="button" aria-label={`Load preview for ${name}`} title={blockedReason || undefined} disabled={loading || Boolean(blockedReason)} onClick={load}><i class={loading ? 'ri-loader-4-line spinning' : icon} aria-hidden="true" /><span>{loading ? progressLabel : 'Load preview'}</span></button>}
      {loading && <div class="attachment-progress" role="status">
        <small>{progressLabel}</small>
        <button type="button" class="attachment-cancel" aria-label={`Cancel loading ${name}`} title="Cancel" onClick={cancel}><i class="ri-close-line" aria-hidden="true" /></button>
      </div>}
      {error && <small class="attachment-error" role="alert">Unavailable: {error}</small>}
    </div>;
  }

  return <div class={`attachment-file${diff ? ' expanded' : ''}`}>
    <div class={`attachment-pill${contextMarker ? ' context-marker' : ''}`}>
      <i class={icon} aria-hidden="true" />
      <span class="attachment-name" title={name}>{name}</span>
      {!contextMarker && sizeLabel && <small>{loading ? progressLabel : sizeLabel}</small>}
      {attachment.kind === 'file_reference' && attachment.path && <button type="button" aria-label={`View diff for ${name}`} title={diffSupported ? 'View diff' : 'Diff viewing is not available on this Avi instance.'} disabled={!diffSupported || diffLoading} onClick={async () => { setDiffLoading(true); setError(''); try { const result = await client.request(METHODS.filesDiff, { filePath: attachment.path }); if (aliveRef.current) setDiff(result.diff ?? result.content ?? ''); } catch (value) { if (aliveRef.current) setError(value.message); } finally { if (aliveRef.current) setDiffLoading(false); } }}><i class="ri-file-diff-line" /></button>}
      {!contextMarker && (url
        ? <a href={url} download={name} aria-label={`Download ${name}`} title="Download"><i class="ri-download-line" /></a>
        : <button type="button" aria-label={`Load ${name}`} title={blockedReason || 'Load from Avi'} disabled={loading || Boolean(blockedReason)} onClick={load}><i class={loading ? 'ri-loader-4-line spinning' : 'ri-download-cloud-2-line'} /></button>)}
    </div>
    {loading && <div class="attachment-progress" role="status">
      <small>{progressLabel}</small>
      <button type="button" class="attachment-cancel" aria-label={`Cancel loading ${name}`} title="Cancel" onClick={cancel}><i class="ri-close-line" aria-hidden="true" /></button>
    </div>}
    {diff && <DiffBlock segment={{ diff }} />}
    {error && <small class="attachment-error" role="alert">Unavailable: {error}</small>}
  </div>;
}

function AttachmentList({ attachments, messageId, client, discovery, assistant = false }) {
  if (!attachments.length) return null;
  return <div class={`attachment-list user-attachment-list${assistant ? ' assistant-attachment-list' : ''}`} aria-label="Message attachments">
    {attachments.map((attachment) => <Attachment key={attachment.id ?? attachment.path} attachment={attachment} messageId={messageId} client={client} discovery={discovery} assistant={assistant} />)}
  </div>;
}

function DiffBlock({ segment }) {
  const lines = String(segment.diff ?? segment.content ?? '').split('\n').map((line, position) => ({ id: `${position}:${line}`, line }));
  return <pre class="diff-block" aria-label="File diff">{lines.map(({ id, line }) => <span key={id} class={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}>{line}</span>)}</pre>;
}

function MarkdownBlock({ text, muted = false }) {
  return <div class={muted ? 'markdown reasoning-text' : 'markdown'} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function ToolEntry({ segment, client, discovery }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [detailsError, setDetailsError] = useState('');
  const name = segment.name ?? segment.toolName ?? segment.toolType ?? 'tool';
  const hasResult = segment.hasResult ?? Object.hasOwn(segment, 'resultText');
  const reason = segment.invocationGoal ?? segment.reason ?? '';
  const detailsSupported = supportsMethod(discovery, METHODS.toolCallDetails);

  useEffect(() => {
    if (!open || !segment.detailsAvailable || !detailsSupported || details?.hasResult === hasResult) return undefined;
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
  }, [client, details?.hasResult, detailsSupported, hasResult, open, segment.detailsAvailable, segment.id, segment.messageId]);

  const input = useMemo(() => {
    const value = String(details?.argumentsText ?? segment.argumentsText ?? '');
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }, [details?.argumentsText, segment.argumentsText]);
  const detailHasResult = details?.hasResult ?? hasResult;
  const output = useMemo(() => {
    const value = String(details?.resultText ?? segment.resultText ?? segment.content ?? '');
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }, [details?.resultText, segment.resultText, segment.content]);
  const loadingDetails = detailsSupported && segment.detailsAvailable && !details && !detailsError;

  return <div class={`tool-entry ${open ? 'open' : ''} ${segment.status === 'error' ? 'error' : ''}`}>
    <button type="button" class="tool-line" aria-expanded={open} onClick={() => setOpen(!open)}>
      {!hasResult && <i class="ri-loader-4-line spinning" aria-label="Waiting for tool output" />}
      <i class={name.startsWith('mcp_') || segment.isMcp ? 'ri-function-line' : 'ri-terminal-box-line'} aria-hidden="true" />
      <span><strong>{name}</strong>{reason && <span class={!hasResult ? 'tool-line-pending-text' : ''}> {reason}</span>}</span>
      <i class="ri-arrow-right-s-line tool-line-chevron" aria-hidden="true" />
    </button>
    {open && <div class="tool-details">
      {segment.detailsAvailable && !detailsSupported
        ? <span role="note">Tool details are not available on this Avi instance.</span>
        : loadingDetails
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

function OperationsGroup({ items, client, discovery, streaming = false, trailing = false }) {
  const [manualOpen, setManualOpen] = useState(null);
  const open = manualOpen ?? (streaming && trailing);
  const visibleItems = items.filter((item) => item.name !== 'ask_question');
  if (!visibleItems.length) return null;
  const label = operationGroupLabel(visibleItems);
  const hasTools = operationGroupHasTools(visibleItems);
  return <div class={`thinking-group ${hasTools ? 'has-tools' : ''} ${open ? 'open' : ''} ${streaming && trailing ? 'is-streaming' : ''}`}>
    <button type="button" class="thinking-summary" aria-expanded={open} onClick={() => setManualOpen(!open)}>
      <span>{label}</span><i class={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} aria-hidden="true" />
    </button>
    {open && <div class="thinking-details"><div class="thinking-details-inner">
      {visibleItems.map((item) => item.type === 'reasoning'
        ? <div class="reasoning-entry" key={item.id ?? `reasoning:${item.text ?? item.content}`}><i class="ri-brain-line" aria-hidden="true" /><MarkdownBlock text={String(item.text ?? item.content ?? '')} muted /></div>
        : item.type === 'tool-call'
          ? <ToolEntry key={item.id ?? item.callId ?? `tool:${item.name}:${item.argumentsText}`} segment={item} client={client} discovery={discovery} />
          : item.type === 'error'
            ? <div class="error-line" key={item.id ?? `error:${item.message ?? item.content}`}>{item.message ?? item.content}</div>
            : null)}
    </div></div>}
  </div>;
}

function TimelineItems({ items, client, discovery, streaming = false }) {
  return <>{items.map((item, index) => item.type === 'content'
    ? <MarkdownBlock key={item.id ?? `content:${item.text}`} text={item.text} />
    : item.type === 'operations'
      ? <OperationsGroup key={item.id ?? `operations:${item.items.map((entry) => entry.id ?? entry.callId ?? entry.type).join(':')}`} items={item.items} client={client} discovery={discovery} streaming={streaming} trailing={index === items.length - 1} />
      : item.type === 'diff'
        ? <DiffBlock key={item.segment.id ?? `diff:${item.segment.diff}`} segment={item.segment} />
        : <section key={item.segment?.id ?? `segment:${item.segment?.type}:${item.segment?.content}`} class={`rich-segment ${item.segment?.type ?? ''}`}>{item.segment?.content && <MarkdownBlock text={String(item.segment.content)} />}</section>)}</>;
}

function WorkedBlock({ items, messages, message, startedAt, client, discovery }) {
  const [open, setOpen] = useState(false);
  return <div class={`worked-block ${open ? 'open' : ''}`}>
    <button type="button" class="worked-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{formatWorkedDuration(startedAt ?? message.createdAt, message.status === 'streaming' ? null : message.updatedAt)}</span><i class={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} aria-hidden="true" />
    </button>
    {open && <div class="worked-details"><div class="worked-details-inner">
      {messages.map((workedMessage) => {
        const structured = parseStructuredAgentMessage(workedMessage);
        return structured
          ? <section key={workedMessage.id} class={`rich-segment ${structured.type}`} aria-label={structured.type === 'subagent-report' ? `Report from ${structured.title}` : `Message from thread ${structured.sourceThreadId}`}>
            <strong>{structured.type === 'subagent-report' ? structured.title : 'Cross-thread message'}</strong>
            <MarkdownBlock text={structured.body} />
          </section>
          : <RichMessage key={workedMessage.id} message={workedMessage} client={client} discovery={discovery} />;
      })}
      <TimelineItems items={items} client={client} discovery={discovery} />
    </div></div>}
  </div>;
}

export function RichMessage({ message, workedMessages = [], workedStartedAt, client, discovery, onFork }) {
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState('');
  const [forking, setForking] = useState(false);
  const actionBusy = useRef(false);
  const user = message.role === 'user';
  const timeline = useMemo(() => buildMessageTimeline(message), [message]);
  const streaming = message.status === 'streaming';
  const { workedItems, finalItems } = useMemo(() => partitionMessageTimeline(timeline, streaming), [timeline, streaming]);

  if (user) {
    return <article class={`message user ${message.status ?? ''}`} data-message-id={message.id}>
      <div class="user-message-content">
        {message.content && <div class="user-bubble"><div class="user-text">{message.content}</div></div>}
        <AttachmentList attachments={message.attachments ?? []} messageId={message.id} client={client} discovery={discovery} />
      </div>
    </article>;
  }

  return <article class={`message assistant ${message.status ?? ''}`} data-message-id={message.id}>
    <div class="assistant-timeline">
      {(workedItems.length > 0 || workedMessages.length > 0) && <WorkedBlock items={workedItems} messages={workedMessages} message={message} startedAt={workedStartedAt} client={client} discovery={discovery} />}
      <TimelineItems items={finalItems} client={client} discovery={discovery} streaming={streaming} />
    </div>
    <AttachmentList attachments={message.attachments ?? []} messageId={message.id} client={client} discovery={discovery} assistant />
    {!streaming && message.role === 'assistant' && <div class="message-actions">
      <button type="button" aria-label={copied ? 'Response copied' : 'Copy response'} title={copied ? 'Copied' : 'Copy response'} disabled={!timeline.some((item) => item.type === 'content' && item.text)} onClick={async () => {
        setActionError('');
        try { await navigator.clipboard.writeText(timeline.filter((item) => item.type === 'content').map((item) => item.text).join('\n\n')); setCopied(true); }
        catch { setCopied(false); setActionError('Could not copy the response. Check clipboard permissions.'); }
      }}><i class={copied ? 'ri-check-line' : 'ri-file-copy-line'} /></button>
      <button type="button" aria-label="Fork chat from this response" title={onFork ? 'Fork chat from this response' : 'Forking is not available on this Avi instance.'} disabled={!onFork || forking} onClick={async () => {
        if (actionBusy.current) return;
        actionBusy.current = true; setForking(true); setActionError('');
        try { await onFork(message.id); }
        catch (error) { setActionError(error.message || 'Could not fork this conversation.'); }
        finally { actionBusy.current = false; setForking(false); }
      }}><i class={forking ? 'ri-loader-4-line spinning' : 'ri-git-branch-line'} /></button>
      {copied && <span role="status">Copied</span>}
      {actionError && <span role="alert">{actionError}</span>}
    </div>}
    {streaming && <div class="assistant-placeholder" aria-live="polite">Thinking</div>}
    {message.status && !['completed', 'sent', 'streaming'].includes(message.status) && <footer class="message-status">{message.status}</footer>}
  </article>;
}
