# voidRoute — Agent Rules

CLI aggregator + local router for AI provider APIs. Runs a local proxy on
`http://localhost:20130/v1`, routes to configured providers, rotates
credentials, handles rate-limit fallback.

## Canonical facts (from wiki)
- Desktop copy `C:\Users\tanas\Desktop\voidRoute` = the one OpenCode sessions run against (63 sessions). `D:\PROICETE\voidRoute` is the canonical git repo.
- Launcher: `voidRoute.bat` (`bun run index.js`). Port 20130; graceful EADDRINUSE handler exists.
- CLI in `cli-ui.js`; proxy backend in `index.js`; SSE in `src/sse/` (`routedTurn` service, injectable adapters).
- Codex integration is deepest: `CodexLifecycle.js`, `CodexAdapter.js`, `CodexCatalog.js`.
- Tests: `bun test` (~7 files, 55/55 at last verified state).

## Build / verify
- Use `bun test` from repo root before claiming any change done.
- Run with `bun run index.js` (NOT `node`).
- Model listing lives in `src/lib/modelSync.js` (`fetchProviderModels`, OAuth-capable).

## Hard rules
- NEVER change Codex state files without atomic write + backup (see CodexLifecycle.js patterns).
- Keep `models_cache.json` stale-wrapper logic intact — breaking it desyncs the Codex picker.
- Don't crash on second launch — EADDRINUSE must stay graceful.

## When resuming
Read `wiki/sessions/voidRoute-*.md` for full technical history (lifecycle audits, transport phase).
