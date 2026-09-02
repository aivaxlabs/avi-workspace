# Avi Workspace Web

A static Preact client for operating an Avi instance through its browser-safe JSON-RPC WebSocket API. This is a remote workspace view, not an Electron port: it contains no Node/Electron bridge and never attempts to read the server machine's filesystem directly.

## Status

First production-quality vertical slice targeting **RPC API v1** only. The client calls `rpc:discover`, displays the negotiated API version, and rejects unknown, missing, older, or newer versions. There is intentionally no legacy transport or authentication fallback.

## Architecture

- `src/rpc/contracts.js` — final-contract method names, API compatibility, pagination, and wire-shape adapters. Protocol uncertainty is isolated here.
- `src/rpc/client.js` — JSON-RPC request correlation, notifications, timeout handling, strict subprotocol negotiation, reconnect behavior, and errors.
- `src/storage/connections.js` — the only browser persistence boundary.
- `src/state/` — pure memory-only UI and authoritative conversation reducers.
- `src/components/` — Connections, sidebar, conversation lifecycle, rich messages, composer, interruptions, and auxiliary tabs.
- `styles/**/*.xcss` — all authored styles. `src/styles.css` is generated only by Cascadium.

One global `/rpc` socket remains active for discovery, conversation polling, creation, and connection status. Selecting a thread opens exactly one `/rpc/conversations/streams/:id` socket. That socket is closed on thread change, disconnect, or unmount. On `conversation:ready`, the client retrieves authoritative `conversations:context`, a bounded recent message page, and the remote composer snapshot. Sequence gaps trigger another authoritative recovery instead of inferred replay.

The composer hydrates exclusively from the `composer` snapshot delivered by `conversations:context` when a thread opens; reconnect recovery for that same thread preserves the local draft and controls instead of reapplying an older snapshot. It never issues a separate `composer-state:get` fetch. Edits autosave through `composer-state:save` (draft text, context markers, permission mode, model, reasoning effort, Plan/Goal work mode, and Ultra flag). While a thread stays open, a non-overlapping periodic `conversations:context` projection refresh keeps run, queue, task, sub-agent, and context-usage counters live. It reconciles the authoritative recent message page by ID so missed stream updates converge, while preserving locally loaded older messages and leaving the composer snapshot untouched.

## Security and persistence

The browser sends WebSocket subprotocols:

1. `avi-rpc-v1`
2. `avi-api-key.<base64url UTF-8 API key>`

The server-selected protocol must be exactly `avi-rpc-v1`. API keys are never put in URLs.

IndexedDB stores **connection records only**: `id`, `label`, `serverUrl`, `apiKey`, `createdAt`, and `updatedAt`. Unsupported fields are rejected at the storage boundary. Layout dimensions, theme, active connection/thread, discovery results, messages, tasks, files, attachment bytes, queues, approvals, and all other UI/remote state stay in memory. The code does not use localStorage, sessionStorage, CacheStorage, a service worker, or browser request caches for state. Composer drafts are read/saved only with remote `composer-state:*` methods when advertised by discovery.

Remote attachments are fetched only after the user chooses **Load preview** and only when `attachments:read` is advertised. Requests carry conversation-owned `messageId` + `attachmentId` and bounded `offset`/`limit`; caller-supplied paths are never sent. Chunks become an in-memory Blob URL that is revoked when its renderer changes or unmounts. Bytes are never persisted. Remote-local file paths are explicitly labeled and are not opened by the browser.

## Final RPC contract assumptions

The implementation consumes only the final RPC v1 browser contract:

- global socket: `/rpc`
- conversation socket: `/rpc/conversations/streams/:id`
- discovery: `rpc:discover`, returning `versions.rpc === 1` and a `methods` string array
- working folders: `folders:list`, grouped by canonical absolute `path`
- folder-bound creation: `conversations:create { projectPath }`; omitting `projectPath` uses the Avi server's home folder
- bounded messages: `{ limit, cursor? }` returning `{ messages, cursor, hasMore }`; projected tool calls use `hasResult` and defer input, output, and media to `conversations:tool-call-details { messageId, segmentId }`
- bounded recovery: `conversations:context` with a limit, returning the `composer` snapshot (draft text, attachments, permission mode, model, reasoning effort, `workMode`, `ultraMode`) and `contextUsage { tokens, limit }`
- message submission: `chat:send { text, model, reasoningEffort, attachments, permissionMode, workMode, ultraMode, steer }`
- conversation-scoped `mentions:list`, `context:commands`, `files:diff { filePath }`, and chunked `attachments:read`
- chunked attachment request: `{ messageId, attachmentId, offset, limit }`; response: `{ data, mime, name, cursor, hasMore }`

There is no path-based, renamed-field, or old-version fallback.

## Supported

- Connection add/edit/delete with confirmation, URL/API-key validation, and online/offline/checking states.
- Compact 222px/collapsed sidebar with folder-grouped navigation, folder colors, Bots, chat search, tag filters and management, global Working/Review groups, agent-created filtering, and conversation rename/fork/archive/delete/copy-ID/tag actions. Every remote action is enabled only when advertised by `rpc:discover`; selecting a completed thread acknowledges it through `sidebar:mark-seen` when available.
- Explicit working-folder selection for new chats and global conversation polling. At 640px and below, the sidebar leaves the layout and the same navigation and management surfaces remain available through the fixed thread header and immersive drawer, alongside fullscreen auxiliary panels.
- Authoritative recovery, bounded history, top lazy loading with scroll preservation, reconnect/error/request-timeout handling. Opening a thread anchors the viewport at the start of its latest user message.
- Markdown/GFM, code, canonical interleaved assistant timelines, expandable reasoning and tool activity/results, file references, diffs, approvals, questions, remote attachments, queue visibility/cancel, send/stop, permission modes, side-chat creation, child-thread navigation, tasks, and remote pickers.
- Composer parity features: styled permission dropdown with labels/descriptions, styled model/reasoning menu, a Plus menu with Plan/Goal/Ultra modes and Side chat (no Electron-only actions), circular send/stop, an edit-diff pill derived from `messages.edits`, task and sub-agent/rubber-duck status strips, queue strips with cancel/steer/reorder actions, and a read-only footer with folder, Git branch, permission lock, and context percentage. Avi's global Queue/Steer preference comes from `models:list.messageDeliveryMode`; Enter uses it and Ctrl+Enter uses the opposite. On phones, the compact composer moves permission selection into the Plus menu and hides the metadata footer.
- Local Remix Icon assets, keyboard-visible focus, named form controls, polite Attention announcements, WCAG AA text contrast, a dark workspace palette, and reduced-motion behavior.

## Explicitly unsupported or discovery-gated

- Direct browser access to paths on the Avi host.
- Local attachment selection/upload until a browser-safe upload contract is defined.
- Attachment or diff previews when the corresponding RPC method is absent.
- Rubber Duck/sub-agent creation unless exposed by the final RPC discovery surface; existing child threads can be listed/opened.
- Any RPC API version other than v1.
- Offline mode or persisted remote caches.

## Development

Requires Bun and a browser with IndexedDB and WebSocket support.

```sh
bun install
bun run dev
```

`bun run dev` compiles XCSS before starting Vite. Vite's development response permits inline styles for CSS hot updates; production builds retain the strict `style-src 'self'` policy from `index.html`. To rebuild styles while editing:

```sh
bun run styles:watch
```

## Test and build

```sh
bun test
bun run build
bun run preview
```

`bun run build` first regenerates `src/styles.css` from `styles/**/*.xcss`, then emits relative static assets under `dist/`. Host `dist/` with any static HTTPS server. The Avi server must accept the page origin, support the browser authentication subprotocol, and expose a secure `wss:` endpoint when the page is served over HTTPS.
