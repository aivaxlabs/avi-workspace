# Changelog

## [Unreleased]

### Fixed

- Relay connections retry automatically after every failure, including AIVAX authorization rejections, invalid tickets or handshakes, Remote rejections, and close codes `1002`, `1008`, `1009`, and `4003`; severe failures use a longer backoff instead of stopping. Direct connections still pause on authentication rejection.
- Relay sends are queued and paced to 100 messages / 3 MiB per sliding second instead of closing the channel when the per-second budget is reached, which avoids relay `1008` traffic closes.
- The mobile auxiliary panel no longer lets the page be zoomed with pinch or double-tap gestures while it is open; one-finger scrolling inside the panel is unchanged.
- The mobile model sheet shows the model and effort selected by the Intelligence slider, places the Effort choices above the model list, and no longer repeats model IDs.

## [0.3.0] - 2026-10-01

### Added

- Mobile Composer photo library, camera photo/video capture, and in-app audio recording on MediaRecorder-capable browsers, with shared attachment limits and media markers.
- Mobile model bottom sheet with intelligence presets and reasoning effort controls; sending, connection-wait and suggestion-loading feedback.
- Connection status strip under the thread header (connecting, opening conversation, disconnected and reconnecting, creating chat) and a skeleton placeholder while a conversation loads.
- Mobile motion: side drawer, bottom-sheet auxiliary panel and dialogs, fading overlays, message entrance and touch press feedback at phone widths; all honour `prefers-reduced-motion`.

### Changed

- **Breaking:** RPC now requires ORPC Draft 2 (`avi-orpc-draft2`) with multipart requests/responses, fresh recovery IDs, reserved cancellation/integrity/heartbeat/shutdown controls, and mandatory SHA-256 `CHECKSEND` verification. Upgrade Desktop and Workspace together; no Draft 1 fallback is provided. The physical `avi-relay-v1` transport is unchanged. Updated the RPC documentation and bundled specification.
- Avi Relay discovery, ticket requests, and the Content Security Policy now use `https://avi-relay.aivax.net`.

### Fixed

- Recover initial transient failures and relay close 1005; Retry reconnects both channels in place without clearing local drafts, attachments or loaded history. Preserve text typed while an earlier send is pending.
- Consolidate repeated connection failures into one delayed warning instead of displaying every transport error; retain technical details in the connection dialog.
- Accept files up to 10 MiB each using native ORPC multipart transfers, with explicit aggregate request limits instead of the old 512 KiB inline limit.
- ORPC ignores byte-identical parts duplicated after dispatch and acknowledges repeated integrity checks without redispatch.
- Returning to the app (visibility, `pageshow`, or `online`) now probes each open channel with a 5 s ORPC ping; a socket that iOS froze in the background is dropped and reconnected immediately instead of leaving requests hanging until their 60 s deadline. Reconnect backoff restarts from zero on resume.
- Server events whose acceptance deadline passed while the tab was suspended are acknowledged and dropped instead of closing the channel; the sequence gap triggers the regular `conversations:context` recovery.
- Protocol and limit rejections (close 1002/1008/1009, relay `protocol`) restart from a fresh ORPC peer with a longer backoff instead of stopping automatic reconnection; only an authentication rejection (4003) still waits for the user.
- Conversation recovery requests that overlap (resume, `conversation:ready`, sequence gaps) coalesce into one run followed by a single follow-up, and a dropped stale event triggers recovery instead of relying on the next sequence check.
- The phone-width auxiliary bottom sheet anchors to the visual viewport, so it stays above the iOS keyboard instead of the layout viewport bottom.

## [0.2.0] - 2026-09-08

### Added

- Chat visualizations: callouts, findings, charts, progress, copyable text, diffs, file references and excerpts, Mermaid diagrams, and LaTeX equations with sanitized rendering and streaming fallbacks.
- Attach files from the composer Plus menu with multiple selection, image previews, and the existing 512 KiB combined inline attachment limit.

### Fixed

- Dismiss composer menus and the model picker when clicking or touching outside their holder.
- Keep cancelled command suggestions closed when delayed requests finish, and clear suggestions when their invocation is removed.
- Preserve visualization instances while streamed response text grows.

## [0.1.0]

### Added

- Clickable connection signal in the instance picker opens live connection details: last call round trip, ORPC transfer rates and byte counters, failed calls, reconnections and channel state. Browser-inaccessible TCP packet loss is explicitly marked unavailable.

- RPC transport upgraded to ORPC Draft 1 (`avi-orpc-draft1`): binary length-prefixed frames carrying UTF-8 JSON operation envelopes (`operationId`, `expiresAt` now + 180 s, `params`), dotted wire methods over the colon application names, acknowledged server events answered with `OK`, no batching, and bounded recovery — at most one retry with a fresh wire request id and identical body (60 s attempt / 150 s overall). The Desktop operation journal deduplicates retries; a lost outcome answers `OUTCOME_UNKNOWN`, cancellation is delivery-only, and delivery is at-least-once, never exactly-once. Breaking: JSON-RPC 2.0 frames are no longer spoken. The bundled wire specification lives at `docs/orpc-spec.md`.

- Relay sessions authenticate with the AIVAX session alone: the Avi Remote key prompt was removed, device selection connects directly, and the relay control envelope is version 3 with `{ type: 'avi-remote-open', version: 3, protocol: 'avi-orpc-draft1', path }` carrying no credential; version 1 and 2 handshakes are rejected instead of marking the channel ready. The physical `avi-relay-v1` subprotocol and direct API-key connections are unchanged.

- Installable PWA manifest, regular/maskable/Apple icons, device theme colors and safe-area styling. A production-only, build-versioned service worker caches public shell assets for offline launch without persisting RPC data or forcing active sessions to reload.

- Mobile composer queue summary opens a bottom sheet with full message text, per-message action menus, readable reorder/prioritize/remove actions, and in-panel feedback.

- Assistant-message actions to copy the answer Markdown and fork the conversation through that response, with clipboard/error feedback and discovery-gated forking.

- Collapsed sidebar uses a centered icon rail with the expand control, New chat, Search, and Connections; branding and conversation groups stay hidden until expanded.

- Compact single-row conversation header and desktop panel resizing with pointer/keyboard controls and in-memory widths.
- Conversation-scoped discovery, refreshed on recovery/reconnection, instead of incorrectly gating conversation tools against global methods.

- Desktop Axion-dark branding: design tokens, official Avi icon with AVI wordmark in the sidebar/connections/empty-chat surfaces and favicon, desktop-style composer surface with inverse send button, and the desktop folder/tag color palette.

- Desktop-sidebar parity with Bots management and activation/snooze actions, chat search, tag catalog and filters, global Working/Review groups, agent-created filtering, folder colors, conversation management actions, and remote completion acknowledgement. Each RPC-dependent control is gated by method discovery, and the existing phone drawer exposes the same surfaces.
- Phone workspace shell with a fixed thread/folder header, hidden sidebar, navigation drawer and modal auxiliary panel, safe-area support, and a compact composer that moves permission selection into the Plus menu.
- Composer rebuilt around authoritative RPC state: `conversations:context` hydrates per-thread state, while `models:list.messageDeliveryMode` supplies Avi's global Queue/Steer preference. Enter uses the configured mode, Ctrl+Enter uses the opposite, draft autosave includes `workMode` and `ultraMode`, and `chat:send` carries the complete composer controls.
- Styled composer controls: permission dropdown with labels and descriptions, model/reasoning-effort menu, Plus menu with Plan/Goal/Ultra modes and Side chat (no Electron-only actions), circular send/stop button, and mode chips.
- Composer strips: edit-diff pill derived from `messages.edits`, task completion and sub-agent/rubber-duck status strips, and queue strips with cancel, steer, and reorder actions; read-only footer with working folder, Git branch and context percentage.
- Periodic authoritative `conversations:context` projection refresh while a thread is open, keeping run/queue/task/agent counters and context usage live without overlapping recovery or clobbering locally loaded history and the composer snapshot.
- Initial static Preact Avi workspace with connection-only IndexedDB storage, strict browser WebSocket authentication, global and conversation RPC lifecycles, bounded history, rich chat, interruptions, remote discovery, and responsive auxiliary tooling.
- Folder-grouped conversation navigation with collapsible sections, bounded Show more controls, per-folder new-chat actions, and an explicit working-folder picker.
- Cascadium/XCSS design system, local Remix Icons, focused unit tests, and architecture/security documentation.
- Quick instance switching from the sidebar and the Connections manager: one active instance at a time, with per-instance memory retention of the selected thread and drafts while the page stays open.
- Draft autosave with visible save status and a retry control after failed saves.

### Fixed

- Center dropdowns, popovers, dialogs, navigation, and auxiliary surfaces in the mobile viewport with safe-area-aware sizing and internal scrolling.
- Move the chat search focus indicator from the inner input to the rounded search bar border.
- Align Workspace typography with the Avi Desktop type scale and component-specific chat, sidebar, control, metadata, and heading sizes.
- Show a valid Remix Icon for the Full access permission mode.
- Remove the duplicate inner textarea outline while preserving the Composer focus indicator.
- Match the chat bottom padding to the measured Composer height and cap the combined Queue/Steer strips with a single scrolling container.
- Exclude `queued` and `steered` messages from the chat timeline so pending prompts render only in the Composer Queue/Steer strips instead of duplicated chat bubbles.
- Refine Working/Review hierarchy and Show more controls, and display only the final folder path segment while preserving full paths in tooltips and RPC state.
- Remove the duplicate Queued prompts section from Tasks; queued messages remain managed in the Composer.
- Replace the long model list with a Desktop-style Advanced picker that separates Model and Effort into focused rows and responsive submenus.
- Improve Queue/Steer strips with distinct mode headers, explanatory copy, compact counters, scrollable message lists, grouped actions, and responsive mobile controls.
- Reconcile recent messages during periodic `conversations:context` refreshes so missed stream updates no longer leave completed tool calls spinning indefinitely, while preserving older history and local composer state.
- Respect projected tool-call `hasResult` state and load deferred input/output through `conversations:tool-call-details`, with visible loading and error feedback.
- Render sidebar dropdowns as viewport-clamped global popovers so they are no longer clipped by sidebar scrolling, only one stays open, and outside click or Escape closes them.
- Move the immersive shell breakpoint from 640px to 860px so tablets get the drawer with named navigation and modal auxiliary panels instead of hidden conversations and bots; the compact composer still switches at 640px.
- Scroll wide code and tool-output blocks internally so 390px phone viewports no longer overflow the page width (confirmed in isolated visual checks at a 390px viewport).
- Restore compact sidebar hierarchy by separating section counts and bot states, styling Working/Review headers, unifying row density, and hiding full lists in the 58px intermediate rail.
- Open each thread with the viewport anchored at the bottom on the latest messages, with a scroll-to-latest control when reading older history.
- Preserve unsaved composer text and controls when the conversation socket reconnects instead of reapplying an older server snapshot for the same thread.
- Allow same-origin development probes and scope Vite's required inline-style permission to the development server without weakening production CSP.
- Restore visible keyboard focus in the composer, correct connection CTA and secondary-text contrast, name free-text questions, and announce Attention changes through an accessible status region.
- Prevent duplicate approval/question RPC mutations and add deterministic keyboard and visual selection behavior to composer suggestions.
- Preserve canonical assistant segment order, separate reasoning from final content, and render expandable Worked/Called tool groups with Desktop-aligned message styling.

### Tests

- Cover completed and pending projected tool calls plus lazy detail loading and failures.
- Cover sidebar snapshot normalization, status precedence, Working/Review grouping, tag and agent-created filters, search normalization, RPC discovery gating, and mounted Bots/search/tags/conversation-action flows while preserving folder and phone-drawer regressions.
- Cover Windows and Unix final folder path segments with preserved full-path tooltips and canonical paths, plus the expanded Show more disclosure state.
- Cover the phone header, immersive navigation and auxiliary-panel surfaces, drawer close-on-selection behavior, and permission choices in the compact Plus menu.
- Mount `Composer` in a browser-like DOM and cover snapshot-only hydration, autosave payloads with modes, `chat:send` payload composition, edit/task/agent strips, queue cancel/steer/reorder actions, and the permission dropdown.
- Cover `conversations:context` composer/context-usage recovery and projection refresh reconciliation of updated and missed recent messages while preserving older history, composer state, and sequence, plus the shared queue action helpers.
- Mount `RichMessage` in a browser-like DOM and exercise Worked/Thought disclosures plus pending, completed, and error tool states.
- Mount folder navigation and cover canonical project grouping, home ordering, bounded expansion, collapse, folder selection, and `projectPath` creation payloads.
