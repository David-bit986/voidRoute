# Codex Multi-Model Picker Implementation Plan

## Objective

Implement the approved [Codex multi-model picker design](../specs/codex-multi-model-picker-design.md) in small, test-first vertical slices. The completed flow must generate one authoritative Codex catalog containing native entries plus every eligible active voidRoute LLM, route picker-safe aliases back to exact upstream IDs, preserve the user’s Codex authentication/configuration, and restore cleanly.

Worktree: `C:\Users\Admin\Documents\Codex\voidRoute-git\.worktrees\codex-multi-model-picker`

Branch: `feat/codex-multi-model-picker`

## Phase 0 — Documentation discovery and allowed contracts

### Evidence consulted

voidRoute:

- `cli-ui.js:103-209` — current live model discovery.
- `cli-ui.js:1299-1758` — active CLI-tool flow and duplicated Codex mutation.
- `src/lib/cli-config/CodexAdapter.js:9-71` — currently unused adapter implementation.
- `src/lib/db/repos/connectionsRepo.js:13-70` — connection shape and `getProviderConnections(filter)`.
- `src/lib/db/repos/aliasRepo.js:9-49` — model alias/custom-model APIs.
- `src/sse/services/model.js:30-58` and `open-sse/services/model.js:146-260` — routing boundary and first-slash parsing.
- `index.js:32-58` — currently broken `/v1/models` route.
- `src/sse/handlers/chat.js:27-160`, `open-sse/handlers/chatCore.js:30+`, and `open-sse/translator/request/openai-responses.js` — active Responses request path.
- `src/lib/mitmAliasCache.js:15-20` — existing local atomic temp-file/rename pattern.

Codex primary sources, pinned at `openai/codex@1836ae0612052137d0cabaff7807ff8314cee940`:

- `codex-rs/core/src/config/mod.rs:1898-1934,3748-3750` — `model_catalog_json` is a startup-loaded `ModelsResponse` override and cannot be empty.
- `codex-rs/model-provider-info/src/lib.rs:53-141,181-215` — strict provider schema; `wire_api = "responses"`; authentication field semantics.
- `codex-rs/model-provider/src/provider.rs:328-348` — a custom catalog selects `StaticModelsManager` and bypasses normal cache/remote discovery.
- `codex-rs/protocol/src/openai_models.rs:365-445,545-590` — `ModelInfo`, `{ models: [...] }`, visibility, and picker conversion.
- `codex-rs/models-manager/src/manager.rs:115-135,357-414` — priority ordering, normal refresh policy, and static-manager behavior.
- OpenAI Codex manual: `config-advanced.md` and `config-reference` sections for root keys and `[model_providers.<id>]`.

opencodex reference, pinned at `lidge-jun/opencodex@b9b73f711663dac5019312d03fda2d1d81c9a10c`:

- `src/providers/slug-codec.ts:24-67` and `tests/slug-codec.test.ts:53-213` — exact slash-safe encoding/decoding and collision behavior.
- `src/codex/paths.ts:32-60` and `src/codex/inject.ts:235-260,310-414` — root TOML key placement and injection lifecycle.
- `src/codex/catalog.ts:395-399,444-537,703-785,946-1051,1863-1936` — template cloning, normalization, backup, sync, and restore.
- `src/codex/journal.ts:27-105` — preimage/injected-hash journal that avoids clobbering later user edits.
- `src/config.ts:11-118` — Windows-aware atomic writes.

### Allowed APIs

- Database: `getProviderConnections({ isActive: true })`, `getModelAliases()`, `getCustomModels()` from `src/lib/localDb.js`.
- Provider metadata: `getProviderAlias(providerId)`, `getModelsByProviderId(providerId)`, and existing provider endpoint definitions.
- Routing: `getModelInfo(modelStr)` as the single decode insertion boundary; preserve `parseModel()` first-slash semantics.
- Request pipeline: existing `handleChat` → `handleChatCore` → `translateRequest`; do not introduce another Responses handler.
- Codex integration: root `model`, `model_provider`, `model_catalog_json`; `[model_providers.voidRoute]` with `wire_api = "responses"` and `requires_openai_auth = false`.
- Catalog: authoritative `{ "models": ModelInfo[] }`, with `visibility = "list"` and ascending `priority`.
- Filesystem: `CODEX_HOME` when set, otherwise `~/.codex`; atomic sibling temp file plus rename.
- Compatibility choice: current Codex can resolve some exact nested slugs from an authoritative catalog, but voidRoute will still publish collision-checked slash-safe aliases so the picker behavior remains compatible across Codex versions and maps deterministically back to native provider IDs.

### Global anti-pattern guards

- Do not write `auth.json` during apply or use `sk_voidRoute` as fake authentication.
- Do not write or delete `models_cache.json`; the custom catalog uses the static manager.
- Do not append root TOML keys after the first table.
- Do not blindly replace `-` with `/`.
- Do not build `/v1/models` independently from catalog discovery/slug generation.
- Do not wire the unused `open-sse/handlers/responsesHandler.js` as a second Responses pipeline.
- Do not edit only `CodexAdapter`; the active TUI currently duplicates the behavior inline.
- Do not generate minimal speculative catalog entries when an installed native template is available.

## Phase 1 — Establish the test harness and exact routed-slug codec

### What to implement

1. Add `"test": "bun test"` to `package.json`; keep the repaired `bun.lock` so the declared `@inquirer/search` dependency is actually locked.
2. Add `src/lib/codex/slugCodec.js` by porting the behavior—not TypeScript types—from opencodex `src/providers/slug-codec.ts:24-67`:
   - `encodeRoutedModelId(id)`
   - `routedSlug(provider, id)`
   - `decodeRoutedModelId(requested, knownIds)`
   - `slugEquals(stored, provider, id)`
3. Add a small catalog-map builder that rejects ambiguous encoded aliases and returns diagnostics instead of guessing.
4. Add `tests/codex-slug-codec.test.js` as the first RED→GREEN tracer bullet.

### Test sequence

1. RED: `openrouter` + `moonshotai/kimi-k3` becomes `openrouter/moonshotai-kimi-k3`.
2. GREEN: implement encoding/routed slug only.
3. RED: native exact selector wins and raw `moonshotai/kimi-k3` remains unchanged.
4. GREEN: implement exact-first decoding.
5. RED: `a/b-c` and `a-b/c` collision is reported and not published.
6. GREEN: implement unique-alias/collision handling.

### Documentation references

- Copy behavioral ordering from opencodex `slug-codec.ts:41-51`.
- Copy assertion shapes from `tests/slug-codec.test.ts:53-86,89-164,182-213`.

### Verification checklist

- `bun test tests/codex-slug-codec.test.js` passes.
- Raw nested selectors remain valid.
- No code performs global hyphen-to-slash replacement.

### Anti-pattern guards

- Do not read files or the database inside the pure codec.
- Do not silently choose one model when two IDs encode to the same alias.

## Phase 2 — Extract shared active-provider model discovery and repair `/v1/models`

### What to implement

1. Extract the Node-side discovery logic from `cli-ui.js:103-209` into `src/lib/providerModels.js` with injectable `fetchImpl` and timeout for testing.
2. Provide a shared orchestration function that:
   - loads only `getProviderConnections({ isActive: true })`;
   - queries each distinct active provider once;
   - normalizes provider-specific responses;
   - falls back to `getModelsByProviderId(provider)` plus stored aliases/custom models;
   - filters out `embedding`, `tts`, `stt`, image, and other non-LLM types;
   - deduplicates by native provider/model pair;
   - produces both native IDs and picker-safe routed IDs through Phase 1’s codec.
3. Update `cli-ui.js` to import this shared fetcher rather than retaining its private copy.
4. Replace `index.js:32-58` with a route backed by the shared list function.
5. Export a pure `buildModelsResponse(discoveredModels)` helper so route behavior is testable without starting the interactive TUI.

### Test sequence

1. RED: an active OpenRouter connection with a fake `/models` response exposes Kimi K3.
2. GREEN: port OpenRouter URL/header/response handling from `cli-ui.js:112-115,184-203`.
3. RED: inactive connections and typed non-LLM models are absent.
4. GREEN: add active filter and type filter.
5. RED: live failure uses static/custom fallback and returns one diagnostic per degraded provider.
6. GREEN: implement merge/fallback.
7. RED: `/v1/models` emits `openrouter/moonshotai-kimi-k3`, never `undefined/[object Object]`.
8. GREEN: replace the broken `conn.providerId`/whole-object implementation.

### Documentation references

- Copy provider URL/header normalization from `cli-ui.js:103-209`.
- Copy live/static display-name merge from `cli-ui.js:1459-1493`.
- Use the actual connection field from `connectionsRepo.js:13-27`.

### Verification checklist

- Focused discovery/model-list tests pass.
- `rg "conn\.providerId|\$\{alias\}/\$\{m\}" index.js` finds no broken route pattern.
- Catalog input and `/v1/models` use the same picker slug for every model.

### Anti-pattern guards

- Do not call the browser-only `fetchSuggestedModels()` utility.
- Do not treat OpenRouter’s static embedding/TTS/image registry as an LLM fallback.
- Do not fetch live provider catalogs on every routing request.

## Phase 3 — Build and atomically write the authoritative Codex catalog/map

### What to implement

1. Add `src/lib/codex/paths.js`:
   - `resolveCodexHome(env, homeDir)`
   - paths for `config.toml`, `voidroute-catalog.json`, `voidroute-model-map.json`, and state/backup files.
2. Add `src/lib/codex/atomicFile.js` by adapting voidRoute’s `mitmAliasCache.js:15-20` and opencodex’s Windows retry/cleanup behavior from `src/config.ts:11-118`.
3. Add `src/lib/codex/catalog.js` with public, testable boundaries:
   - load a baseline from an existing user-selected catalog, a prior pristine backup, or read-only `models_cache.json`;
   - find and deep-clone a native entry containing `base_instructions`;
   - preserve native catalog entries;
   - create routed entries for discovered models;
   - replace slug/display/description/visibility/priority;
   - strip native OpenAI service-tier metadata from routed models;
   - validate the final `{ models: [...] }` is non-empty and JSON round-trippable;
   - produce an owned-slug manifest plus exact picker-to-native model map;
   - atomically write generated files only after validation.
4. Use stable priority: selected default first, other routed entries next, preserved native entries after them without relying on array order.

### Test sequence

1. RED: Kimi K3 becomes a list-visible routed catalog entry while retaining strict template fields.
2. GREEN: implement template cloning and routed identity.
3. RED: service-tier/fast-only fields are absent on routed models; native entries remain unchanged.
4. GREEN: add normalization.
5. RED: generated map decodes the selected Kimi slug exactly; collisions are excluded with diagnostics.
6. GREEN: write catalog/map construction.
7. RED: missing usable template causes no target file mutation.
8. GREEN: validate before atomic replace.

### Documentation references

- Copy template discovery order from opencodex `catalog.ts:703-721,733-785`.
- Copy routed-entry normalization fields from `catalog.ts:444-537,946-995`.
- Match the official `ModelInfo`/`ModelsResponse` schema at `openai_models.rs:365-445,545-550`.

### Verification checklist

- Catalog unit tests pass using temporary `CODEX_HOME` fixtures.
- Generated wrapper contains both preserved native and routed entries.
- JSON parse succeeds after atomic write.
- No production test touches `C:\Users\Admin\.codex`.

### Anti-pattern guards

- Do not make the catalog routed-only; it is authoritative, not additive.
- Do not mutate `models_cache.json`.
- Do not overwrite a pristine backup after routed entries exist.
- Do not use a minimal hand-authored entry if a real installed template is available.

## Phase 4 — Add idempotent root-TOML injection, journaled restore, and legacy-auth cleanup

### What to implement

1. Add pure transforms in `src/lib/codex/configToml.js`:
   - read root keys only before the first table;
   - inject/update root `model`, `model_provider`, and `model_catalog_json`;
   - insert/update one managed `[model_providers.voidRoute]` block;
   - preserve unrelated content and dominant LF/CRLF style;
   - configure `wire_api = "responses"` and `requires_openai_auth = false`.
2. Add `src/lib/codex/journal.js` using the opencodex preimage/injected-hash pattern:
   - record original config and catalog ownership state before first injection;
   - record hashes after injection;
   - restore automatically only when managed state is unchanged;
   - preserve later user edits and report a conflict instead of overwriting them.
3. Implement idempotent restore that restores previous root values/managed section, uses the pristine catalog backup, and removes only manifest-owned routed entries/files.
4. Keep a narrowly scoped legacy cleanup function that removes `auth_mode = "apikey"` and `OPENAI_API_KEY = "sk_voidRoute"` only when both exact old sentinel values are present. New apply never writes `auth.json`.

### Test sequence

1. RED: root keys are before `[features]` and the provider block is strict-schema valid.
2. GREEN: port root reader/inserter pattern from opencodex.
3. RED: repeated injection produces no duplicate roots or provider blocks and updates endpoint/default model.
4. GREEN: make transform idempotent.
5. RED: unrelated TOML/comments and CRLF survive.
6. GREEN: preserve EOL/content boundaries.
7. RED: restore returns original values; later user edits cause a safe conflict result.
8. GREEN: implement journal/hash checks.
9. RED: apply leaves `auth.json` byte-identical; reset only removes the exact legacy sentinel.
10. GREEN: separate legacy cleanup from apply.

### Documentation references

- Copy root-only parsing from opencodex `paths.ts:32-60`.
- Copy insertion/idempotency semantics from `inject.ts:235-260,310-414`.
- Copy conflict-safe journal behavior from `journal.ts:27-105` and its tests.
- Match official provider fields from `model-provider-info/src/lib.rs:79-141`.

### Verification checklist

- Config/journal/restore tests pass in temp directories.
- `rg "authData\.OPENAI_API_KEY|authData\.auth_mode" cli-ui.js src/lib/cli-config` finds no apply-path mutation.
- A generated provider block contains no unknown keys.

### Anti-pattern guards

- Do not restore a full old config over later user edits without a hash match.
- Do not remove all slash-bearing entries; use the owned manifest/pristine backup.
- Do not set `requires_openai_auth = true` for the local proxy.

## Phase 5 — Wire catalog sync into the active TUI and eliminate the dead duplicate path

### What to implement

1. Add `src/lib/codex/integration.js` with:
   - `syncCodexIntegration({ defaultModel, endpoint, ...deps })`
   - `restoreCodexIntegration({...deps})`
   - `getCodexIntegrationStatus({...deps})`
2. Sync ordering:
   - discover and validate all active LLM models;
   - ensure selected default is present;
   - build/validate catalog + exact map in memory;
   - write journal/pristine backup;
   - atomically write catalog/map;
   - atomically inject config;
   - return model counts, degraded providers, collisions, and `restartRequired: true`.
3. Refactor `src/lib/cli-config/CodexAdapter.js` to delegate to the integration service and make apply/reset asynchronous.
4. Replace `cli-ui.js:1709-1758` with the adapter/service call so the active user flow no longer maintains a second implementation.
5. Update status detection to verify managed root/provider/catalog state rather than substring search.
6. Change the TUI success output from “Custom Model” to the number of synchronized picker models plus a clear “Restart Codex to reload the picker” message.

### Test sequence

1. RED: a temp-home integration sync produces config, catalog, map, and status for two providers.
2. GREEN: orchestrate prior modules.
3. RED: selected raw Kimi model is encoded as the configured default and appears in the catalog.
4. GREEN: normalize the default through the exact model set.
5. RED: repeated apply updates without duplicates; reset restores and is repeatable.
6. GREEN: wire journaled lifecycle.
7. RED: active `manageCliTools` Codex flow calls the shared integration and never writes auth on apply.
8. GREEN: remove the inline duplicate.

### Documentation references

- Follow opencodex orchestration order from `src/codex/sync.ts:29-77`, minus its cache mutation.
- Preserve voidRoute’s current CLI selection contract at `cli-ui.js:1436-1533`.

### Verification checklist

- Temp-home integration tests pass.
- `cli-ui.js` contains no direct Codex TOML/auth writes.
- Adapter and TUI use one integration implementation.
- User output states restart is required.

### Anti-pattern guards

- Do not partially inject config before catalog validation succeeds.
- Do not configure only the selected provider; the picker must include every eligible active provider model.
- Do not mutate the user’s real Codex home during automated tests.

## Phase 6 — Decode picker aliases at the single routing boundary and verify Responses/tool calls

### What to implement

1. Load the exact generated map through a small cached reader with mtime-based invalidation.
2. Update `src/sse/services/model.js:getModelInfo(modelStr)` before its current non-alias fast path:
   - preserve exact raw provider/model selectors;
   - resolve an exact picker alias from the generated map;
   - pass unknown IDs through unchanged.
3. Keep the active `/v1/responses` chain unchanged after model resolution.
4. Add an integration fixture with a local fake OpenRouter Chat Completions server. Send a Responses-format request containing tools through `handleChat`; assert:
   - upstream body model is `moonshotai/kimi-k3`;
   - tool definitions are translated to Chat Completions form;
   - returned Chat Completions SSE tool deltas become valid Responses events.

### Documentation references

- Insert decode at the boundary proven by `src/sse/handlers/chat.js:98-160`.
- Preserve the existing translation chain at `open-sse/translator/index.js:73-120` and `request/openai-responses.js`.
- Copy exact-first/unique-alias behavior from opencodex `router.ts:39-56,243-258`.

### Verification checklist

- Routing integration test passes for encoded and raw Kimi selectors.
- Streaming test observes `response.function_call_arguments.*`, output-item completion, and `response.completed`.
- Existing `handleResponsesCore` remains unused.

### Anti-pattern guards

- Do not decode after executor dispatch.
- Do not introduce a provider-specific Kimi special case.
- Do not fork a second Responses implementation.

## Phase 7 — Focused project audit and durable documentation

### What to implement

1. Run an independent code review over changed paths and adjacent Codex/model-routing code.
2. Fix only clear, reproducible defects with focused tests. Already confirmed and included:
   - stale `bun.lock` missing declared `@inquirer/search` graph;
   - `/v1/models` using `conn.providerId` instead of `conn.provider`;
   - `/v1/models` interpolating entire model objects;
   - duplicate active/dead Codex config implementations;
   - apply overwriting Codex authentication.
3. Investigate other suspicious findings—such as duplicate provider registry keys—but only change them if a failing behavior test proves the defect and the intended replacement is unambiguous.
4. Update `README.md`:
   - Codex now supports multiple synchronized picker models;
   - custom catalog is startup-loaded, so restart is required;
   - raw nested IDs remain accepted while picker IDs are slash-safe;
   - reset restores prior integration and does not remove ChatGPT login.

### Verification checklist

- Each audit fix has a reproducer/test.
- README behavior matches the implementation.
- No unrelated large refactor is included.

### Anti-pattern guards

- Do not “clean up” subjective style or rename broad APIs during the audit.
- Do not fix ambiguous duplicate definitions without proving intended behavior.

## Final phase — Verification gate and GitHub handoff

### Focused verification

- Run every new test file individually during its RED→GREEN cycle.
- Run `bun test` for the full suite.
- Run import/syntax checks on all changed ES modules.
- Run the temp-home Codex integration test on Windows path and CRLF fixtures.
- Run the fake OpenRouter Responses/tool-call integration test.

### Contract verification

- Parse the generated catalog as `{ models: [...] }`; assert non-empty and unique slugs.
- Assert every picker-visible entry has `visibility = "list"` and required cloned fields.
- Assert provider TOML has only documented fields and root keys precede tables.
- Assert apply does not modify `auth.json` or `models_cache.json`.
- Assert reset is idempotent and conflict-safe.

### Anti-pattern grep

```powershell
rg -n 'conn\.providerId|\[object Object\]|authData\.OPENAI_API_KEY|authData\.auth_mode' index.js cli-ui.js src
rg -n 'models_cache.*write|write.*models_cache' src cli-ui.js
rg -n 'handleResponsesCore' index.js src open-sse
```

Expected results:

- no broken connection/model interpolation patterns;
- no apply-path auth or cache writes;
- only the pre-existing unused Responses handler definition, with no new caller.

### Manual handoff verification

- Do not mutate the user’s real `C:\Users\Admin\.codex` automatically during tests.
- Provide a dry-run/generated-fixture summary and exact manual steps for configuring voidRoute, restarting Codex, selecting Kimi K3, and restoring.
- Review `git diff`, commit history, and working-tree status.
- Push/open a PR only through the repository’s publish workflow after tests and review pass.

## Definition of done

- Multiple active voidRoute LLMs appear as separate Codex App/CLI picker entries after configuration and restart.
- Kimi K3 via OpenRouter is selectable and routes upstream as `moonshotai/kimi-k3`.
- Text streaming and tool calls remain valid through the existing Responses pipeline.
- Apply/sync/reset are atomic, idempotent, and preserve authentication/unrelated config.
- `/v1/models` matches the catalog’s picker-safe IDs.
- Automated tests and the final verification gate pass.
- Confirmed adjacent defects are fixed with tests; speculative cleanup is excluded.
