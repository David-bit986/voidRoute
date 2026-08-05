# voidRoute

![voidRoute CLI Menu](assets/screenshot.png)

voidRoute is a terminal-based CLI aggregator and local router for AI provider APIs. It runs the voidRoute proxy backend locally and provides an interactive terminal user interface (TUI).

---

## Inspiration
This project uses the database schema, token rotation, and SSE proxy backend from the open-source **[9router](https://github.com/decolua/9router)** server. It wraps these services in a command-line interface.

---

## Features

* **Dynamic Model Listing**: Queries live `/v1/models` (or provider-equivalent) endpoints from active providers (OpenAI, DeepSeek, Gemini, Anthropic, Mistral, Ollama, Groq, and 20+ more). Falls back to a static registry if the provider is unreachable.
* **Standalone Model Fetcher**: Use `fetch-models.mjs` to query any provider's model list directly:
  ```bash
  bun run fetch-models.mjs --provider deepseek --key sk-xxx
  bun run fetch-models.mjs --url https://api.deepseek.com/models --key sk-xxx
  ```
* **Single vs. Multi-Model Configuration**: When configuring a CLI tool, you can pick a **single default model** or, for tools that support it (OpenCode, Pi Agent, OpenAI Codex), register **ALL models** from a provider in one step.
* **Config Path Detection**: Automatically finds CLI tool configs even if installed in non-standard locations (e.g., `~/.openclaude/settings.json` vs `~/.claude/settings.json`).
* **Automated Tool Configuration**: Generates and deletes configuration files for:
  * **Claude Code** (`~/.claude/settings.json`)
  * **OpenClaude** (`~/.openclaude/settings.json`) — uses OpenAI-compatible routing for non-Anthropic models
  * **OpenCode** (`~/.config/opencode/opencode.json`) — **multi-model** capable
  * **OpenAI Codex** (`~/.codex/config.toml` & `models_cache.json`) — **multi-model** capable (OpenCodex)
  * **Aider** (`~/.aider.conf.yml`)
  * **Pi Agent** (`~/.pi/agent/models.json`) — **multi-model** capable
  * **Cline** (`~/.cline/data/globalState.json`)
  * **Cursor** (Manual Guide)
* **Mouse Input Prevention**: Disables terminal mouse tracking to prevent clicks and hovers from disrupting menu list navigation.
* **Token Refresh Dedup**: Prevents race conditions between proactive and reactive OAuth token refreshes for Google-based providers (Antigravity, Gemini CLI).

---

## Single vs. Multi-Model Configuration

| CLI Tool | Model Config | Notes |
|----------|-------------|-------|
| **Claude Code** | Single | Sets 1 model via `ANTHROPIC_DEFAULT_*_MODEL` env vars |
| **OpenClaude** | Single | Smart routing: non-Anthropic models use OpenAI-compatible mode |
| **OpenCode** | **Multi** ✅ | Registers all models under `provider.voidRoute.models` |
| **Pi Agent** | **Multi** ✅ | Registers all models under `providers.voidRoute.models` |
| **OpenAI Codex** | **Multi** ✅ | OpenCodex proxy routing via `config.toml` & `models_cache.json` — use any LLM in Codex CLI/App |
| **Aider** | Single | Sets 1 model in `.aider.conf.yml` |
| **Cline** | Single | Sets 1 model in `globalState.json` |
| **Cursor** | — | Manual configuration required |

When you select a tool that supports multi-model, you'll be asked: *"Register ALL N models from this provider?"* If you say yes, every model from that provider gets written into the config — no need to manually add them one by one.

---

## Setup

1. **Prerequisites**: Install [Bun](https://bun.sh/).
   ```bash
   bun --version
   ```
2. **Installation**: Clone the repository and install dependencies.
   ```bash
   bun install
   ```
3. **Usage**: Start the CLI app.
   ```bash
   bun index.js
   ```

On Windows, double-click **`Start_voidRoute.bat`** to start immediately.

---

## Operation
voidRoute runs a local server on port `20130`.

* **Proxy endpoint**: `http://localhost:20130/v1`

Redirect your developer tools to this endpoint. The server routes requests to your configured providers, rotates credentials, and handles rate-limiting fallbacks.
