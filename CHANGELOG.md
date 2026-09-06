# Changelog

## [Unreleased]

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
