# Codex Multi-Model Picker Design

## Summary

voidRoute will expose every eligible model from its active provider connections as a normal entry in the shared Codex model catalog. Codex CLI, TUI, and App will then show those entries in their native model picker instead of presenting one generic “Custom Model.”

The implementation will keep voidRoute as a dedicated Responses-compatible provider. It will not replace Codex’s built-in OpenAI provider, overwrite the user’s ChatGPT login, or attempt broader opencodex feature parity.

## Goals

- Show multiple voidRoute-routed LLMs in the Codex model picker.
- Include live OpenRouter models such as `moonshotai/kimi-k3`.
- Route the picker-safe ID `openrouter/moonshotai-kimi-k3` back to the native upstream ID `moonshotai/kimi-k3`.
- Keep catalog synchronization and restoration idempotent.
- Preserve unrelated Codex configuration and authentication state.
- Add automated tests for the new public behavior.

## Non-goals

- ChatGPT account pooling or quota balancing.
- Background service installation or automatic startup.
- Claude Code integration.
- Image, web-search, or vision sidecars.
- Replacing Codex’s native OpenAI provider or rewriting thread history.
- Broad codebase refactoring unrelated to the picker integration.

Clear, reproducible defects found while implementing or verifying this feature may be fixed in a separate audit pass. Larger architectural changes will be reported rather than silently folded into this feature.

## User experience

When the user configures Codex through voidRoute:

1. voidRoute discovers LLM models from every active provider connection.
2. It writes a Codex-shaped catalog to `$CODEX_HOME/voidroute-catalog.json`.
3. It writes an exact alias map to `$CODEX_HOME/voidroute-model-map.json`.
4. It injects the catalog path and dedicated provider into `$CODEX_HOME/config.toml`.
5. It tells the user to restart Codex because `model_catalog_json` is loaded at startup.
6. After restart, Codex App/CLI shows the routed entries in its standard picker.

The selected model remains the default, but the user may switch to any other synchronized voidRoute entry directly from Codex.

## Architecture

### 1. Reusable provider-model discovery

The provider model-fetching logic currently embedded in `cli-ui.js` will move behind a reusable module. The module will:

- query a provider’s live model endpoint using its active connection;
- normalize provider-specific response shapes;
- fall back to the existing static registry when live discovery fails;
- merge stored custom model aliases where applicable;
- retain only LLM models for the Codex catalog;
- deduplicate models by native provider ID and model ID.

The CLI model selector and Codex catalog synchronizer will use the same discovery behavior so their lists do not drift.

### 2. Slash-safe routed model IDs

Codex metadata lookup expects a routed model slug to contain exactly one `/`. Some upstream IDs already contain `/`, including OpenRouter’s `moonshotai/kimi-k3`.

The Codex-facing encoding will be:

```text
<provider>/<native model with inner slashes replaced by hyphens>
```

Example:

```text
Native:        moonshotai/kimi-k3
Codex picker:  openrouter/moonshotai-kimi-k3
```

Decoding will never blindly replace every hyphen with `/`. Catalog sync will write an exact map from each picker slug to its native provider/model pair. Routing will resolve an exact native selector first, then an exact catalog alias, and otherwise pass the requested model through so the upstream provider can return an honest error.

If two native IDs from the same provider would encode to the same picker slug, neither ambiguous alias will be published. Synchronization will report the collision and keep both raw selectors usable.

Raw selectors such as `openrouter/moonshotai/kimi-k3` will remain supported for backward compatibility.

### 3. Codex catalog builder

The catalog builder will load a native model template from the user’s existing Codex catalog or `models_cache.json`. Each routed entry will clone that template and replace its routed identity:

```text
slug = <picker-safe routed slug>
display_name = <picker-safe routed slug>
description = Routed via voidRoute to <provider>/<native model>
visibility = list
```

Cloning preserves strict fields Codex expects, including base instructions, reasoning levels, shell type, supported API flags, tool metadata, and input modalities.

Provider-specific metadata that cannot be honored through a generic route, particularly native OpenAI fast/service-tier fields, will be removed from routed entries. Existing native entries will be preserved.

If no usable native template exists, synchronization will stop with a clear error and leave Codex configuration untouched.

### 4. Codex configuration manager

Configuration transforms will be implemented as testable functions rather than additional inline regular expressions in the TUI.

The injected root keys will appear before the first TOML table:

```toml
model_provider = "voidRoute"
model_catalog_json = "C:/absolute/path/to/voidroute-catalog.json"
```

The dedicated provider will be:

```toml
[model_providers.voidRoute]
name = "voidRoute"
base_url = "http://127.0.0.1:20130/v1"
wire_api = "responses"
requires_openai_auth = false
```

Injection will preserve unrelated root keys, tables, comments, and the file’s dominant line ending. Repeated synchronization will update one managed block instead of duplicating keys or sections.

The new flow will not write `OPENAI_API_KEY`, `auth_mode`, or any other field in Codex’s `auth.json`. Existing cleanup for the legacy `sk_voidRoute` placeholder will remain available during reset.

### 5. Backup, restore, and reload

Before the first injection, voidRoute will save the original Codex integration state under `$CODEX_HOME` in a voidRoute-owned backup file. The backup will contain only the data required to restore:

- whether `model_provider` existed and its original value;
- whether `model_catalog_json` existed and its original value;
- any pre-existing `model_providers.voidRoute` section;
- the original catalog used as the merge baseline.

Reset will restore those values, remove only voidRoute-owned generated catalog/map files, and preserve user changes that do not overlap the managed keys.

voidRoute will not edit `models_cache.json`. When `model_catalog_json` is configured, current Codex builds use the custom catalog as an authoritative startup-only source and bypass the normal remote-model cache. After sync or reset, the TUI will tell the user to restart Codex.

Generated files will be written atomically through a temporary sibling followed by rename, preventing partial JSON or TOML if the process is interrupted.

## Data flow

```text
active provider connections
        |
        v
provider model discovery --live failure--> static/custom fallback
        |
        v
LLM filter + deduplication
        |
        +--> exact picker-to-native alias map
        |
        v
clone native Codex template into routed catalog entries
        |
        +--> voidroute-catalog.json
        +--> voidroute-model-map.json
        +--> config.toml managed keys/provider
        +--> restart-required status

Codex request model
        |
        v
raw native exact match -> alias-map exact match -> passthrough
        |
        v
existing Responses-to-provider translation and key rotation
```

## Error handling

- Live model discovery failure uses the static/custom fallback and reports which provider was degraded.
- A provider with no known LLM models is skipped rather than producing a malformed entry.
- Missing or malformed Codex template data aborts before configuration mutation.
- Invalid generated JSON aborts before atomic replacement.
- A stale or missing alias map preserves existing raw-selector routing.
- Reset is safe to run repeatedly, including after a partial prior setup.
- Existing user-owned catalog configuration is backed up and restored rather than overwritten permanently.

## Public behavior and compatibility

- `GET /v1/models` will return the same picker-safe routed IDs used by the generated catalog.
- `POST /v1/responses` and `POST /v1/chat/completions` will accept picker-safe IDs and raw native IDs.
- Existing model aliases and provider prefixes remain valid.
- Existing single-model configuration becomes the default selection within the new multi-model catalog.
- The proxy stays on its existing default port `20130`.

## Testing strategy

Tests will use Bun’s test runner and public module interfaces.

1. Slug codec tests prove nested OpenRouter IDs encode and decode exactly, raw IDs remain valid, and ambiguous hyphenated names are not guessed.
2. Catalog tests prove native fields are preserved, routed identity is replaced, unsupported service tiers are removed, non-LLM models are excluded, and Kimi K3 appears under its picker-safe slug.
3. Configuration tests prove root-key placement, idempotent reinjection, unrelated TOML preservation, and absence of auth-file mutation.
4. Restore tests prove original provider/catalog values return and repeated reset is safe.
5. Model-list tests prove `/v1/models` and catalog generation use identical routed IDs.
6. A focused integration test sends a Responses-format tool request through a fake OpenRouter endpoint and verifies the upstream receives `moonshotai/kimi-k3` while the client receives valid Responses events.

The repository will gain an explicit `test` script so `bun test` is a meaningful baseline and CI entry point.

## Acceptance criteria

- After Codex configuration, at least two eligible active voidRoute models appear as separate native picker entries.
- `openrouter/moonshotai-kimi-k3` appears when Kimi K3 is discovered from an active OpenRouter connection.
- Selecting that entry sends `moonshotai/kimi-k3` upstream.
- Streaming text and tool calls continue to use valid Responses API events.
- Re-running sync produces no duplicate TOML keys, provider blocks, or catalog entries.
- Reset restores the pre-voidRoute Codex provider/catalog configuration and does not remove the user’s ChatGPT authentication.
- Automated tests cover catalog generation, exact slug routing, configuration mutation, restoration, and the OpenRouter Responses path.

## Rollout

The first release will synchronize during Codex configuration and expose a reusable sync function for later CLI/dashboard wiring. If users need refresh while voidRoute is already running, a dedicated command or dashboard action can regenerate the same catalog; Codex must then be restarted because the catalog override is loaded at startup.
