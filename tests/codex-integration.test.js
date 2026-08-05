import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getCodexIntegrationStatus,
  restoreCodexIntegration,
  syncCodexIntegration,
} from "../src/lib/codex/integration.js";
import { getCodexPaths } from "../src/lib/codex/paths.js";

const temporaryDirectories = [];

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const nativeModel = {
  slug: "gpt-native",
  display_name: "GPT Native",
  description: "Native Codex model",
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast" },
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  additional_speed_tiers: ["fast"],
  service_tiers: [{ id: "priority", name: "Fast", description: "Fast" }],
  availability_nux: null,
  upgrade: null,
  base_instructions: "You are Codex, an agent based on GPT-5.",
  support_verbosity: true,
  default_verbosity: "low",
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: true,
  context_window: 128000,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
};

describe("Codex multi-model integration", () => {
  test("syncs all active models while leaving Codex auth and cache byte-identical", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-sync-"));
    temporaryDirectories.push(directory);
    const paths = getCodexPaths({ env: { CODEX_HOME: directory } });
    const originalConfig = "# user config\r\n[features]\r\nmulti_agent = true\r\n";
    const originalAuth = '{"tokens":{"access_token":"chatgpt-session"}}\n';
    const originalCache = JSON.stringify({ models: [nativeModel] });
    await writeFile(paths.config, originalConfig);
    await writeFile(paths.auth, originalAuth);
    await writeFile(paths.modelsCache, originalCache);

    const result = await syncCodexIntegration({
      defaultModel: "openrouter/moonshotai/kimi-k3",
      baseUrl: "http://127.0.0.1:20130/v1",
      paths,
      discoverModels: async () => ({
        models: [
          { provider: "anthropic", id: "claude-sonnet", name: "Claude" },
          {
            provider: "openrouter",
            id: "moonshotai/kimi-k3",
            name: "Kimi K3",
          },
        ],
        diagnostics: [],
      }),
    });

    const config = await readFile(paths.config, "utf8");
    const catalog = JSON.parse(await readFile(paths.catalog, "utf8"));
    const modelMap = JSON.parse(await readFile(paths.modelMap, "utf8"));

    expect(result).toEqual({
      configuredModel: "openrouter/moonshotai-kimi-k3",
      routedModelCount: 2,
      nativeModelCount: 1,
      diagnostics: [],
      collisions: [],
      restartRequired: true,
    });
    expect(config).toContain('model = "openrouter/moonshotai-kimi-k3"');
    expect(config).toContain('model_catalog_json = "');
    expect(config).toContain("[model_providers.voidRoute]");
    expect(config).toContain("requires_openai_auth = false");
    expect(catalog.models.map((model) => model.slug)).toEqual([
      "openrouter/moonshotai-kimi-k3",
      "anthropic/claude-sonnet",
      "gpt-native",
    ]);
    expect(modelMap.models["openrouter/moonshotai-kimi-k3"]).toEqual({
      provider: "openrouter",
      model: "moonshotai/kimi-k3",
    });
    expect(await readFile(paths.auth, "utf8")).toBe(originalAuth);
    expect(await readFile(paths.modelsCache, "utf8")).toBe(originalCache);
    expect(await getCodexIntegrationStatus({ paths })).toEqual({
      connected: true,
      configuredModel: "openrouter/moonshotai-kimi-k3",
      routedModelCount: 2,
      catalogModelCount: 3,
    });
  });

  test("repeated sync stays idempotent and reset restores the original files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-reset-"));
    temporaryDirectories.push(directory);
    const paths = getCodexPaths({ env: { CODEX_HOME: directory } });
    const originalConfig = '# original\nmodel = "gpt-native"\n';
    await writeFile(paths.config, originalConfig);
    await writeFile(paths.modelsCache, JSON.stringify({ models: [nativeModel] }));
    const syncOptions = {
      defaultModel: "openrouter/moonshotai/kimi-k3",
      baseUrl: "http://127.0.0.1:20130/v1",
      paths,
      discoverModels: async () => ({
        models: [
          { provider: "openrouter", id: "moonshotai/kimi-k3" },
        ],
        diagnostics: [],
      }),
    };

    await syncCodexIntegration(syncOptions);
    await syncCodexIntegration(syncOptions);
    const injected = await readFile(paths.config, "utf8");
    expect((injected.match(/^model\s*=/gm) || []).length).toBe(1);
    expect((injected.match(/^\[model_providers\.voidRoute\]$/gm) || []).length)
      .toBe(1);

    expect(await restoreCodexIntegration({ paths })).toEqual({
      restored: true,
      conflicts: [],
      legacyAuthCleaned: false,
      restartRequired: true,
    });
    expect(await readFile(paths.config, "utf8")).toBe(originalConfig);
    expect({
      catalog: await exists(paths.catalog),
      modelMap: await exists(paths.modelMap),
      state: await exists(paths.state),
      backup: await exists(paths.backup),
    }).toEqual({
      catalog: false,
      modelMap: false,
      state: false,
      backup: false,
    });
    expect(await restoreCodexIntegration({ paths })).toEqual({
      restored: false,
      conflicts: [],
      legacyAuthCleaned: false,
      restartRequired: false,
    });
    expect(await getCodexIntegrationStatus({ paths })).toEqual({
      connected: false,
      configuredModel: "gpt-native",
      routedModelCount: 0,
      catalogModelCount: 0,
    });
  });

  test("reset reports a conflict without partially restoring user-edited files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-conflict-"));
    temporaryDirectories.push(directory);
    const paths = getCodexPaths({ env: { CODEX_HOME: directory } });
    await writeFile(paths.config, "# original\n");
    await writeFile(paths.modelsCache, JSON.stringify({ models: [nativeModel] }));
    await syncCodexIntegration({
      defaultModel: "openrouter/moonshotai/kimi-k3",
      baseUrl: "http://127.0.0.1:20130/v1",
      paths,
      discoverModels: async () => ({
        models: [
          { provider: "openrouter", id: "moonshotai/kimi-k3" },
        ],
        diagnostics: [],
      }),
    });
    const catalogBeforeReset = await readFile(paths.catalog, "utf8");
    const editedConfig = `${await readFile(paths.config, "utf8")}# later user edit\n`;
    await writeFile(paths.config, editedConfig);

    expect(await restoreCodexIntegration({ paths })).toEqual({
      restored: false,
      conflicts: ["config"],
      legacyAuthCleaned: false,
      restartRequired: false,
    });
    expect(await readFile(paths.config, "utf8")).toBe(editedConfig);
    expect(await readFile(paths.catalog, "utf8")).toBe(catalogBeforeReset);
    expect(await exists(paths.state)).toBe(true);
  });
});
