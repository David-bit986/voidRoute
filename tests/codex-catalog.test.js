import { describe, expect, test } from "bun:test";

import { buildCodexCatalog } from "../src/lib/codex/catalog.js";

const nativeTemplate = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses" },
    { effort: "high", description: "More reasoning" },
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 9,
  base_instructions: "You are Codex, an agent based on GPT-5.",
  context_window: 272000,
};

describe("Codex catalog generation", () => {
  test("adds Kimi K3 as a picker-visible routed model and preserves native entries", () => {
    const baseline = { models: [nativeTemplate] };

    const result = buildCodexCatalog({
      baseline,
      discoveredModels: [
        {
          provider: "openrouter",
          id: "moonshotai/kimi-k3",
          name: "Kimi K3",
        },
      ],
      defaultModel: "openrouter/moonshotai-kimi-k3",
    });

    expect(result.catalog).toEqual({
      models: [
        {
          ...nativeTemplate,
          slug: "openrouter/moonshotai-kimi-k3",
          display_name: "openrouter/moonshotai-kimi-k3",
          description:
            "Routed via voidRoute to openrouter/moonshotai/kimi-k3.",
          priority: -1,
          base_instructions:
            "You are Codex, powered by moonshotai/kimi-k3 through voidRoute.",
        },
        nativeTemplate,
      ],
    });
    expect(result.modelMap).toEqual({
      models: {
        "openrouter/moonshotai-kimi-k3": {
          provider: "openrouter",
          model: "moonshotai/kimi-k3",
        },
      },
    });
    expect(result.manifest).toEqual({
      version: 1,
      ownedSlugs: ["openrouter/moonshotai-kimi-k3"],
    });
    expect(baseline).toEqual({ models: [nativeTemplate] });
  });

  test("removes OpenAI-only service and transport metadata from routed models", () => {
    const openAiOnlyMetadata = {
      additional_speed_tiers: ["fast"],
      service_tier: "priority",
      service_tiers: [{ id: "priority", name: "Fast" }],
      default_service_tier: "priority",
      model_messages: { instructions_template: "GPT-specific" },
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      use_responses_lite: true,
      supports_websockets: true,
      availability_nux: { message: "New OpenAI model" },
      upgrade: { model: "gpt-next" },
    };
    const baseline = {
      models: [{ ...nativeTemplate, ...openAiOnlyMetadata }],
    };

    const { catalog } = buildCodexCatalog({
      baseline,
      discoveredModels: [
        { provider: "openrouter", id: "moonshotai/kimi-k3" },
      ],
    });
    const [routed, native] = catalog.models;

    expect(
      Object.keys(openAiOnlyMetadata).filter(
        (key) => key !== "upgrade" && Object.hasOwn(routed, key),
      ),
    ).toEqual([]);
    expect(routed.upgrade).toBeNull();
    expect(native).toEqual({ ...nativeTemplate, ...openAiOnlyMetadata });
  });

  test("assigns deterministic picker priorities with the selected model first", () => {
    const { catalog } = buildCodexCatalog({
      baseline: { models: [nativeTemplate] },
      discoveredModels: [
        { provider: "anthropic", id: "claude-sonnet" },
        { provider: "openrouter", id: "moonshotai/kimi-k3" },
      ],
      defaultModel: "openrouter/moonshotai/kimi-k3",
    });

    expect(
      catalog.models.map(({ slug, priority }) => ({ slug, priority })),
    ).toEqual([
      { slug: "openrouter/moonshotai-kimi-k3", priority: -2 },
      { slug: "anthropic/claude-sonnet", priority: -1 },
      { slug: "gpt-5.6-sol", priority: 9 },
    ]);
  });
});
