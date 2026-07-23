import { describe, expect, test } from "bun:test";

import {
  cleanLegacyCodexAuth,
  injectCodexConfig,
  readCodexRootValues,
} from "../src/lib/codex/configToml.js";

describe("Codex TOML integration", () => {
  test("routes through native Codex while preserving the built-in provider", () => {
    const original = [
      "# user comment",
      "[features]",
      "multi_agent = true",
      "",
      "[projects.'C:\\\\work']",
      "trust_level = \"trusted\"",
      "",
    ].join("\r\n");

    const updated = injectCodexConfig(original, {
      model: "openrouter/moonshotai-kimi-k3",
      catalogPath: "C:\\Codex\\voidroute-catalog.json",
      baseUrl: "http://127.0.0.1:20130/v1",
    });

    expect(updated).toBe(
      [
        "# user comment",
        'model = "openrouter/moonshotai-kimi-k3"',
        'model_catalog_json = "C:\\\\Codex\\\\voidroute-catalog.json"',
        "# Auto-injected by voidRoute",
        'openai_base_url = "http://127.0.0.1:20130/v1"',
        "",
        "[features]",
        "multi_agent = true",
        "",
        "[projects.'C:\\\\work']",
        "trust_level = \"trusted\"",
        "",
      ].join("\r\n"),
    );
  });

  test("updates an existing integration without duplicating managed keys or tables", () => {
    const first = injectCodexConfig("model = \"old\"\n[features]\nfoo = true\n", {
      model: "anthropic/claude-sonnet",
      catalogPath: "/tmp/old-catalog.json",
      baseUrl: "http://localhost:1111/v1",
    });
    const second = injectCodexConfig(first, {
      model: "openrouter/moonshotai-kimi-k3",
      catalogPath: "/tmp/new-catalog.json",
      baseUrl: "http://localhost:20130/v1",
    });

    expect({
      second,
      rootModelCount: (second.match(/^model\s*=/gm) || []).length,
      providerCount: (second.match(/^\[model_providers\.voidRoute\]$/gm) || [])
        .length,
      baseUrlCount: (second.match(/^openai_base_url\s*=/gm) || []).length,
    }).toEqual({
      second: injectCodexConfig(second, {
        model: "openrouter/moonshotai-kimi-k3",
        catalogPath: "/tmp/new-catalog.json",
        baseUrl: "http://localhost:20130/v1",
      }),
      rootModelCount: 1,
      providerCount: 0,
      baseUrlCount: 1,
    });
  });

  test("removes only the exact legacy voidRoute authentication sentinel", () => {
    const legacy = JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk_voidRoute",
      tokens: { access_token: "keep-me" },
    });
    const realApiKey = JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-real-user-key",
    });

    expect(cleanLegacyCodexAuth(legacy)).toEqual({
      changed: true,
      content: `${JSON.stringify({ tokens: { access_token: "keep-me" } }, null, 2)}\n`,
    });
    expect(cleanLegacyCodexAuth(realApiKey)).toEqual({
      changed: false,
      content: realApiKey,
    });
  });

  test("reads managed values only from the TOML root", () => {
    const source = [
      'model = "gpt-native"',
      'model_catalog_json = "C:\\\\catalog.json"',
      'openai_base_url = "http://127.0.0.1:20130/v1"',
      "[profiles.work]",
      'model = "profile-model"',
      'model_provider = "profile-provider"',
    ].join("\n");

    expect(readCodexRootValues(source)).toEqual({
      model: "gpt-native",
      model_catalog_json: "C:\\catalog.json",
      openai_base_url: "http://127.0.0.1:20130/v1",
    });
  });

  test("removes a legacy custom provider without changing native tables", () => {
    const legacy = [
      'model = "openrouter/moonshotai-kimi-k3"',
      'model_provider = "voidRoute"',
      'model_catalog_json = "C:\\old.json"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      "[model_providers.voidRoute]",
      'name = "voidRoute"',
      'base_url = "http://127.0.0.1:20130/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
    ].join("\n");

    const updated = injectCodexConfig(legacy, {
      model: "openrouter/moonshotai-kimi-k3",
      catalogPath: "C:\\new.json",
      baseUrl: "http://127.0.0.1:20130/v1",
    });

    expect(updated).not.toContain('model_provider = "voidRoute"');
    expect(updated).not.toContain("[model_providers.voidRoute]");
    expect(updated).toContain('openai_base_url = "http://127.0.0.1:20130/v1"');
  });

  test("does not overwrite a user-owned openai_base_url", () => {
    const original = [
      'openai_base_url = "http://127.0.0.1:9999/v1"',
      "[features]",
      "multi_agent = true",
      "",
    ].join("\n");

    const updated = injectCodexConfig(original, {
      model: "openrouter/moonshotai-kimi-k3",
      catalogPath: "/tmp/catalog.json",
      baseUrl: "http://127.0.0.1:20130/v1",
    });

    expect(updated).toContain('openai_base_url = "http://127.0.0.1:9999/v1"');
    expect(updated).not.toContain("# Auto-injected by voidRoute");
  });
});
