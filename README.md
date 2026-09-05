# Avi Workspace

A browser workspace for connecting to your Avi desktop instances, managing conversations, and working with your agents remotely.

**Hosted app:** [workspace.aivax.net](https://workspace.aivax.net) · **Source:** [aivaxlabs/avi-workspace](https://github.com/aivaxlabs/avi-workspace)

## Quick start

1. Open the hosted app in a modern browser.
2. Choose **Login with AIVAX** to discover your account's relay-connected devices, or **Add connection** to configure an Avi RPC endpoint manually.
3. Select an instance and open or create a conversation.

You need a running Avi instance with remote access configured. This website hosts the browser client only; it does not host an Avi instance or an AI inference service. For direct connections from the HTTPS app, use a secure `wss:` endpoint and allow `https://workspace.aivax.net` in the Avi server's origin configuration.

## Overview

A static Preact client for operating an Avi instance through its browser-safe JSON-RPC WebSocket API. This is a remote workspace view, not an Electron port: it contains no Node/Electron bridge and never attempts to read the server machine's filesystem directly.

## Status

Functional vertical slice targeting **RPC API v1** only. The client calls `rpc:discover`, displays the negotiated API version, and rejects unknown, missing, older, or newer versions. There is intentionally no legacy transport or authentication fallback. `bun test` provides automated unit and DOM coverage; behavior against a live Avi instance is not yet verified in real-world use.

## AIVAX remote relay

Next to **Add connection**, **Login with AIVAX** asks for the account login key delivered by email. It exchanges `{ loginKey }` at `https://inference.aivax.net/api/v1/auth/login`, then uses `data.accessToken` as a Bearer credential for `GET https://avi-relay.projpw.workers.dev/v1/relays`. The dialog displays the remote computers without individual connection actions. **Approve account** saves the access token in IndexedDB and adds every returned device to the main remote-instance list. Every time the Connections page opens, the saved token automatically fetches the current devices without asking for another login key. Open an instance from the main list; all discovered instances also appear in the workspace switcher. Manual refresh updates the list, and **Log out** removes the saved token and account devices. The login key is cleared after authentication and is never persisted. Authentication rejection clears the saved token and asks for login again; temporary service failures retain it for retry. Requests omit cookies and reject redirects.

`src/rpc/relay-socket.js` acquires a fresh consumer ticket for each attempt and negotiates `avi-relay-v1` with the ticket subprotocol. AIVAX authentication replaces the Avi Remote key on WAN: the first application frame is `{ type: 'avi-remote-open', version: 2, path }` with no credential, and RPC becomes available only after `{ type: 'avi-remote-ready', version: 2 }`; legacy version 1 handshakes are rejected instead of being accepted. The global `/rpc` route and selected `/rpc/conversations/streams/:id` route use independent consumers. Switching threads closes the previous stream; exiting closes both channels.

Heartbeat uses versioned `avi-remote-ping/pong` frames, with a 60-second deadline. Transient failures retry with jittered exponential backoff (approximately 1–30 seconds), reset only after 30 stable seconds. Authentication/protocol/limit failures stop retries. Pending RPC requests fail with **unknown outcome**, never automatic command replay. Reconnection refreshes discovery and authoritative conversation context while preserving older loaded messages and the composer. Payloads and outgoing buffers/rates are bounded; this is not an unlimited transport.

Direct connections remain unchanged and keep the Avi API key; relay sessions authenticate with the AIVAX session only. Contract and UI tests use mocked services; a live Desktop/Workspace relay session still requires validation. TLS terminates at Cloudflare; there is no additional end-to-end encryption.

## Architecture

- `src/rpc/contracts.js` — final-contract method names, API compatibility, pagination, and wire-shape adapters. Protocol uncertainty is isolated here.
- `src/rpc/client.js` — JSON-RPC request correlation, notifications, timeout handling, strict subprotocol negotiation, reconnect behavior, and errors.
- `src/storage/connections.js` — the only browser persistence boundary.
- `src/state/` — pure memory-only UI and authoritative conversation reducers.
- `src/components/` — Connections, sidebar, conversation lifecycle, rich messages, composer, interruptions, and auxiliary tabs.
- `styles/**/*.xcss` — all authored styles. `src/styles.css` is generated only by Cascadium.

One global `/rpc` socket remains active for discovery, conversation polling, creation, and connection status. Selecting a thread opens exactly one `/rpc/conversations/streams/:id` socket. That socket is closed on thread change, disconnect, or unmount. Discovery is scoped per socket: sidebar actions use the global method list, while composer, message details, attachments, and auxiliary actions use the conversation method list. On every `conversation:ready`, including reconnection, the client refreshes conversation discovery and retrieves authoritative `conversations:context`, a bounded recent message page, and the remote composer snapshot. Sequence gaps trigger another authoritative recovery instead of inferred replay.

The composer hydrates first from its per-conversation in-memory cache and then reconciles with the authoritative `composer` snapshot delivered by `conversations:context`; reconnect recovery for that same thread preserves the local draft and controls instead of reapplying an older snapshot. It never issues a separate `composer-state:get` fetch. Edits autosave through `composer-state:save` (draft text, context markers, permission mode, model, reasoning effort, Plan/Goal work mode, and Ultra flag) with serialized requests, visible save status, and a retry control when a save fails. Switching away cancels pending debounce timers and retains unsynced drafts in memory for the next visit; closing or reloading the browser tab loses that local cache. While a thread stays open, a non-overlapping periodic `conversations:context` projection refresh keeps run, queue, task, sub-agent, and context-usage counters live. It reconciles the authoritative recent message page by ID so missed stream updates converge, while preserving locally loaded older messages and leaving the composer snapshot untouched.

## Client state

One Avi instance is active at a time. The sidebar instance selector and the Connections manager switch between saved instances without re-entering credentials, and per-instance workspace memory keeps the selected thread and per-conversation drafts in memory while the page stays open, so switching back restores the previous view. The conversation header stays on one compact row. Desktop sidebar and auxiliary-panel edges can be dragged or adjusted with Arrow keys (Shift for larger steps), Home, and End. Widths are bounded to preserve conversation space and retained only in per-instance memory; mobile panels are not resizable. Nothing remote is persisted to the browser; only connection records and the approved AIVAX access token live in IndexedDB (see Security and persistence).

Draft autosave is not offline storage: a page reload or crash before a successful save still loses recent edits.

Global instance status and the periodic projection refresh run serialized, so a refresh never overlaps recovery or status handling. Tool-call detail panels load on demand through `conversations:tool-call-details`, and every remote capability across sidebar, composer, attachments, and auxiliary panels is enabled only when `rpc:discover` advertises the method.

## Installable PWA

Serve the production `dist/` directory over HTTPS (localhost also works). Chromium exposes installation in its browser menu; on iOS/iPadOS use Safari → Share → Add to Home Screen. The target is current Chromium and Safari/iOS 16.4+, with platform installation behavior requiring physical-device verification. Relative manifest URLs support subdirectory hosting; serve `sw.js` as JavaScript without redirects and preferably with `Cache-Control: no-cache`.

The interface automatically follows the system light/dark preference through `prefers-color-scheme`, including browser chrome where supported, without a saved theme setting. The standalone app uses dedicated regular/maskable/Apple icons, dynamic viewport height and safe-area insets; its manifest launch colors and iOS translucent status-bar style remain dark. After its first successful online load, the public app shell can open offline. Connections remain in IndexedDB; conversations, drafts and attachment bytes are not cached. Closing the app can lose unsynced drafts.

The browser checks and downloads service-worker updates in the background. There is no forced reload or `skipWaiting`: close all Workspace windows/tabs and reopen to activate a downloaded update. Service workers are event-driven, not permanent background processes: they do not keep RPC WebSockets alive, send queued messages while closed, or guarantee timers. Background sync, push notifications and notification permissions are not implemented.

## Security and persistence

The browser sends WebSocket subprotocols:

1. `avi-rpc-v1`
2. `avi-api-key.<base64url UTF-8 API key>`

The server-selected protocol must be exactly `avi-rpc-v1`. API keys are never put in URLs.

IndexedDB stores direct connection records (`id`, `label`, `serverUrl`, `apiKey`, `createdAt`, and `updatedAt`) and the approved AIVAX access token in a separate account store. The token is a browser-persisted credential, accessible to code running on this origin; use logout to remove it on shared browsers. Unsupported fields are rejected at the storage boundary. Layout dimensions, theme, active connection/thread, discovery results, messages, tasks, files, attachment bytes, queues, approvals, and all other UI/remote state stay in memory. The code does not use localStorage or sessionStorage. The production service worker uses CacheStorage only for the public, versioned application shell (HTML, JavaScript, CSS, fonts, icons and manifest), never for RPC traffic, API keys, conversations or attachments. Composer drafts are read/saved only with remote `composer-state:*` methods when advertised by discovery.

Remote attachments are fetched only after the user chooses **Load preview** and only when `attachments:read` is advertised. Requests carry conversation-owned `messageId` + `attachmentId` and a bounded per-chunk `offset`/`limit` that follows the server cursor until `hasMore` ends the attachment, with an enforced maximum of 25 MiB per attachment and a Cancel control that stops further chunk requests; caller-supplied paths are never sent. Chunks become an in-memory Blob URL that is revoked when its renderer changes or unmounts. Bytes are never persisted. Remote-local file paths are explicitly labeled and are not opened by the browser.

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
- Explicit working-folder selection for new chats and global conversation polling. At 860px and below — tablets and phones — the sidebar leaves the layout and the same navigation and management surfaces remain available through the fixed thread header and an immersive drawer with named rows, alongside modal auxiliary panels. The composer keeps its compact styles only at 640px and below. At that size, a queue summary opens a bottom sheet with full messages and per-message actions to move, apply at the next step, or remove an item; desktop retains inline queue controls.
- Authoritative recovery, bounded history, top lazy loading with scroll preservation, reconnect/error/request-timeout handling. Opening a thread anchors the viewport at the bottom on the latest messages.
- Markdown/GFM, code, canonical interleaved assistant timelines, expandable reasoning and tool activity/results, file references, diffs, approvals, questions, remote attachments, queue visibility/cancel, send/stop, permission modes, side-chat creation, child-thread navigation, tasks, and remote pickers.
- Composer parity features: styled permission dropdown with labels/descriptions, styled model/reasoning menu, a Plus menu with Plan/Goal/Ultra modes and Side chat (no Electron-only actions), circular send/stop, an edit-diff pill derived from `messages.edits`, task and sub-agent/rubber-duck status strips, queue strips with cancel/steer/reorder actions, and a read-only footer with folder, Git branch, and context percentage. Avi's global Queue/Steer preference comes from `models:list.messageDeliveryMode`; Enter uses it and Ctrl+Enter uses the opposite. On phones (640px and below), the compact composer moves permission selection into the Plus menu and hides the metadata footer.
- Local Remix Icon assets, keyboard-visible focus, named form controls, polite Attention announcements, WCAG AA text contrast, a dark workspace palette, and reduced-motion behavior.

## Explicitly unsupported or discovery-gated

- Direct browser access to paths on the Avi host.
- File-picker and chunked upload are not implemented. Clipboard images/files are accepted as inline attachments, up to 512 KiB combined, within Avi's 1 MiB WebSocket message limit.
- Attachment or diff previews when the corresponding RPC method is absent.
- Rubber Duck/sub-agent creation unless exposed by the final RPC discovery surface; existing child threads can be listed/opened.
- Any RPC API version other than v1.
- Offline RPC operations or persisted remote caches. The installed shell can launch offline after a successful initial load, but remote data and actions require a connection.

## Pending RPC capabilities

- Large attachment transfer requires a browser-safe chunked upload method. Small clipboard images/files use the documented Attachment.dataUrl format through existing composer/save and send methods; no host paths are supplied.
- Sub-agent and Rubber Duck creation wait for creation methods advertised by `rpc:discover`; listing and opening existing child threads already works.
- Draft saves are last-write-wins: `composer-state:save` has no revision checking or compare-and-set, so two writers on the same conversation can overwrite each other (see the Avi RPC v1 `composer-state:save` contract). Atomic or revision-checked draft saves are a roadmap dependency and are not implemented.
- Other saved instances are not monitored in background. Aggregated monitoring requires separately scoped session/subscription design.

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

`bun test` is automated unit and DOM coverage; it does not verify real-world behavior against a live Avi server, which remains unverified.

Avi's RPC endpoint binds to the local loopback host by default. Reaching it from another machine requires a `wss:`-capable tunnel or reverse proxy with TLS; exposing the endpoint and its security is the operator's responsibility. Deployments must keep the strict production CSP unchanged.

## Deploy to Cloudflare Workers

The app is deployed as **Workers Static Assets**, with no application Worker, database, or server-side secrets. `wrangler.jsonc` defines the asset directory and the `workspace.aivax.net` custom domain. Cloudflare provisions DNS and TLS for the custom domain in the authenticated account.

```sh
git clone https://github.com/aivaxlabs/avi-workspace.git
cd avi-workspace
bun install --frozen-lockfile
bun test
bun run build
bunx wrangler@4.129.0 login
bunx wrangler@4.129.0 deploy
```

The deploying account must have access to the `aivax.net` zone. For a fork, change the Worker name and custom domain in `wrangler.jsonc` before deploying. Upload only `dist/`, never the repository, credentials, or local configuration. The existing production CSP remains part of the generated HTML.

Deployment is manual; pushing to GitHub does not automatically deploy the site. The installed PWA caches the application shell, not remote conversations. When a new version is available, use its update prompt to reload.
