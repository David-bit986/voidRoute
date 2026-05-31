# 🌌 voidRoute

![voidRoute CLI Menu](assets/screenshot.png)

`voidRoute` is a lightweight, terminal-based CLI router and aggregator that brings multiple AI providers (both API Key and OAuth-based) directly into your command line. It reuses the core logic of the popular **9Router** proxy server, replacing the web dashboard with a modern, interactive Terminal User Interface (TUI).

---

## 🎨 Inspiration
This project is heavily inspired by and built on top of the open-source **[9Router](https://github.com/decolua/9router)** library. It inherits its database schema, token rotation/refresh systems, and SSE proxy architecture, but packages them into a fully automated terminal shell tool.

---

## 🚀 Key Features

* **Resized Side-by-Side ASCII Art**: Launches with a customized, terminal-safe galaxy visualization and `voidRoute` logo printed next to each other.
* **Real-time Model Discovery**: Dynamically queries each provider's `/v1/models` endpoint (OpenAI, Gemini, DeepSeek, OpenRouter, Mistral, Ollama, etc.) to fetch up-to-date models in real-time, with local offline fallbacks.
* **Direct Links to Docs**: If a model list can't be fetched or you want to verify compatibility, the CLI prints direct, clickable documentation links for the chosen provider.
* **TUI Combo Wizard**: Build fallback chains (combos) with a step-by-step wizard, or generate auto-combos across your active providers in one click.
* **Automated CLI Configs**: Directly writes and removes configurations for tools like:
  * **Claude Code** (`~/.claude/settings.json`)
  * **Cline** (`~/.cline/data/globalState.json` & `secrets.json`)
  * **OpenCode** (`~/.config/opencode/opencode.json`)
  * **Aider** (`~/.aider.conf.yml`)
  * **Pi Agent** (`~/.pi/agent/models.json` & `settings.json`)
  * **Codex** (`~/.codex/config.toml` & `auth.json`)
* **Mouse Reporting Ignored**: Explicitly disables terminal mouse-hijacking modes on startup so clicks/hovers don't interfere with your arrow selections.

---

## 🛠️ Installation & Setup

1. Make sure you have [Bun](https://bun.sh/) installed:
   ```bash
   bun --version
   ```
2. Clone the repository and install the dependencies:
   ```bash
   bun install
   ```
3. Run the CLI app:
   ```bash
   bun index.js
   ```

Alternatively, on Windows, you can double-click the **`voidRoute.bat`** script on your desktop to launch it immediately.

---

## ⚙️ How it Works
When running, `voidRoute` spawns a local server on port `20130`. 
* **Proxy endpoint**: `http://localhost:20130/v1`
* All compatible CLI tools are redirected to this port. `voidRoute` automatically translates incoming requests, rotates your configured tokens, and manages provider-level fallbacks if an API is overloaded or rate-limited.
