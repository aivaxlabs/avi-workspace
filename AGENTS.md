# Avi Workspace Web agent guide

## Project overview
- This is a static Preact/Vite browser client for operating an Avi instance through the browser-safe JSON-RPC WebSocket API.
- It targets RPC API v1 only. It is not an Electron port and has no direct access to the Avi host filesystem.
- `README.md` is the authoritative feature, protocol, security, and persistence overview.

## Repository map
- `src/main.jsx` mounts the application and imports Remix Icons plus generated `src/styles.css`.
- `src/App.jsx` owns saved-connection selection, the global RPC client, discovery, workspace polling, and session teardown.
- `src/components/` contains connection management and workspace UI, including the sidebar, conversation surface, composer, and rich-message rendering.
- `src/rpc/` contains the strict RPC v1 contract, WebSocket transport, URL/auth subprotocol construction, and message pagination.
- `src/state/` and `src/lib/` contain pure conversation/UI state updates and presentation helpers.
- `src/storage/connections.js` is the only browser-persistence boundary.
- `styles/` contains authored Cascadium XCSS; read `styles/AGENTS.md` before changing styles.
- `tests/` contains Bun unit and Preact DOM tests. `dist/` and `src/styles.css` are generated outputs.

## Architecture and boundaries
- Keep protocol method names, discovery validation, pagination shapes, and wire adapters in `src/rpc/contracts.js`; keep transport lifecycle and request correlation in `src/rpc/client.js`.
- Optional remote actions must remain gated by methods advertised by `rpc:discover`. Do not add legacy method, renamed-field, authentication, or unsupported-version fallbacks.
- Preserve the socket model: one global `/rpc` connection and one `/rpc/conversations/streams/:id` connection for the selected thread. Close the conversation socket on thread change, disconnect, or unmount.
- Treat `conversations:context` as authoritative recovery. Sequence gaps trigger recovery rather than inferred replay; projection refreshes must preserve loaded older messages and local composer state.
- API keys travel only in the WebSocket authentication subprotocol, never in URLs. IndexedDB may store only the connection fields and the user-approved AIVAX access token enforced by `src/storage/connections.js`; remote messages, UI state, and attachment bytes stay in memory.
- Remote attachment reads use conversation-owned `messageId` and `attachmentId` with bounded chunks. Do not send caller-provided host paths; revoke in-memory Blob URLs when replaced or unmounted.
- Keep browser-independent transformations in `src/lib/` or `src/state/` and UI lifecycle behavior in Preact components. Follow adjacent tests when extending either layer.

## Commands
Run from the project root with Bun:

- `bun install` — install dependencies.
- `bun run dev` — regenerate styles, then start Vite.
- `bun run styles:watch` — rebuild XCSS continuously while editing styles.
- `bun test tests/<name>.test.js` or `bun test tests/<name>.test.jsx` — run a focused test file.
- `bun test` — run the complete test suite.
- `bun scripts/test-relay-e2e.mjs` — real-socket relay end-to-end check against a local v2 relay peer; runs in its own process because DOM tests replace `globalThis.WebSocket`.
- `bun run build` — regenerate styles and produce the static site in `dist/`.
- `bun run preview` — serve the existing production build locally.

## Validation
- Run the narrowest affected test first, then `bun test` when the change crosses RPC, state, storage, or component boundaries.
- Run `bun run styles` after XCSS changes and inspect the generated selector/cascade changes; do not hand-edit `src/styles.css`.
- Run `bun run build` for entry-point, dependency, CSP, asset, or production-output changes.
- Tests use Bun's preload from `bunfig.toml`; DOM tests use `happy-dom`, while IndexedDB tests use `fake-indexeddb`.

## Instruction map
- `styles/AGENTS.md` — Cascadium authoring, organization, generated CSS, and style validation.
