import { describe, expect, test } from "bun:test";

import {
  buildModelsResponse,
  discoverProviderModels,
  fetchProviderModels,
} from "../src/lib/providerModels.js";

describe("provider model discovery", () => {
  test("discovers Kimi K3 from an active OpenRouter connection", async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          data: [{ id: "moonshotai/kimi-k3", name: "Kimi K3" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const models = await fetchProviderModels(
      "openrouter",
      { apiKey: "test-key" },
      { fetchImpl },
    );

    expect({ models, request: requests[0] }).toEqual({
      models: [{ id: "moonshotai/kimi-k3", name: "Kimi K3" }],
      request: {
        url: "https://openrouter.ai/api/v1/models",
        options: {
          headers: {
            Accept: "application/json",
            Authorization: "Bearer test-key",
          },
          signal: expect.any(AbortSignal),
        },
      },
    });
  });

  test("normalizes Gemini's provider-specific model response", async () => {
    let requestedUrl;
    const models = await fetchProviderModels(
      "gemini",
      { apiKey: "gemini-key" },
      {
        fetchImpl: async (url) => {
          requestedUrl = url;
          return Response.json({
            models: [
              {
                name: "models/gemini-2.5-pro",
                displayName: "Gemini 2.5 Pro",
              },
              { name: "publishers/google/not-a-model" },
            ],
          });
        },
      },
    );

    expect({ requestedUrl, models }).toEqual({
      requestedUrl:
        "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key",
      models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
    });
  });

  test("normalizes Ollama's local tags response", async () => {
    const models = await fetchProviderModels(
      "ollama",
      {},
      {
        fetchImpl: async (url) => {
          expect(url).toBe("http://localhost:11434/api/tags");
          return Response.json({ models: [{ name: "qwen3:8b" }] });
        },
      },
    );

    expect(models).toEqual([{ id: "qwen3:8b", name: "qwen3:8b" }]);
  });

  test("derives a model endpoint for an OpenAI-compatible connection", async () => {
    let request;
    const models = await fetchProviderModels(
      "openai-compatible-local",
      {
        apiKey: "custom-key",
        providerSpecificData: {
          baseUrl: "https://example.test/v1/chat/completions",
        },
      },
      {
        fetchImpl: async (url, options) => {
          request = { url, options };
          return Response.json({ data: [{ id: "custom-chat" }] });
        },
      },
    );

    expect({ request, models }).toEqual({
      request: {
        url: "https://example.test/v1/models",
        options: {
          headers: {
            Accept: "application/json",
            Authorization: "Bearer custom-key",
          },
          signal: expect.any(AbortSignal),
        },
      },
      models: [{ id: "custom-chat", name: "custom-chat" }],
    });
  });

  test("normalizes a top-level model array without losing model types", async () => {
    const models = await fetchProviderModels(
      "openai-compatible-local",
      {
        providerSpecificData: { baseUrl: "https://example.test/v1" },
      },
      {
        fetchImpl: async () => Response.json([
          "plain-model",
          { id: "chat-model", name: "Chat Model", type: "llm" },
          { name: "embed-model", type: "embedding" },
        ]),
      },
    );

    expect(models).toEqual([
      { id: "plain-model", name: "plain-model" },
      { id: "chat-model", name: "Chat Model", type: "llm" },
      { id: "embed-model", name: "embed-model", type: "embedding" },
    ]);
  });

  test("preserves model types from an OpenAI-style data envelope", async () => {
    const models = await fetchProviderModels(
      "openrouter",
      { apiKey: "test-key" },
      {
        fetchImpl: async () => Response.json({
          data: [{ id: "embedding-model", type: "embedding" }],
        }),
      },
    );

    expect(models).toEqual([
      {
        id: "embedding-model",
        name: "embedding-model",
        type: "embedding",
      },
    ]);
  });

  test.each([
    [
      "openai",
      "https://api.openai.com/v1/models",
      { Accept: "application/json", Authorization: "Bearer provider-key" },
    ],
    [
      "deepseek",
      "https://api.deepseek.com/models",
      { Accept: "application/json", Authorization: "Bearer provider-key" },
    ],
    [
      "anthropic",
      "https://api.anthropic.com/v1/models",
      {
        Accept: "application/json",
        "x-api-key": "provider-key",
        "anthropic-version": "2023-06-01",
      },
    ],
  ])("uses the %s provider's model endpoint and authentication", async (
    provider,
    expectedUrl,
    expectedHeaders,
  ) => {
    let request;
    await fetchProviderModels(
      provider,
      { apiKey: "provider-key" },
      {
        fetchImpl: async (url, options) => {
          request = { url, headers: options.headers };
          return Response.json({ data: [] });
        },
      },
    );

    expect(request).toEqual({ url: expectedUrl, headers: expectedHeaders });
  });

  test("returns an empty list when a provider request fails", async () => {
    const models = await fetchProviderModels(
      "openrouter",
      { apiKey: "test-key" },
      {
        fetchImpl: async () => {
          throw new Error("network down");
        },
      },
    );

    expect(models).toEqual([]);
  });

  test("returns only LLMs from active provider connections", async () => {
    const connectionFilters = [];
    const fetchedProviders = [];

    const result = await discoverProviderModels({
      getConnections: async (filter) => {
        connectionFilters.push(filter);
        return [
          { provider: "openrouter", isActive: true },
          { provider: "inactive-provider", isActive: false },
        ];
      },
      fetchModels: async (provider) => {
        fetchedProviders.push(provider);
        return [
          { id: "moonshotai/kimi-k3", name: "Kimi K3", type: "llm" },
          { id: "openai/text-embedding-3-small", type: "embedding" },
        ];
      },
      getStaticModels: () => [],
      getAliases: async () => ({}),
      getCustomModels: async () => [],
      getProviderAlias: (provider) => provider,
    });

    expect({ result, connectionFilters, fetchedProviders }).toEqual({
      result: {
        models: [
          {
            provider: "openrouter",
            id: "moonshotai/kimi-k3",
            name: "Kimi K3",
            source: "live",
          },
        ],
        diagnostics: [],
      },
      connectionFilters: [{ isActive: true }],
      fetchedProviders: ["openrouter"],
    });
  });

  test("falls back to static, alias, and custom LLMs when live discovery fails", async () => {
    const result = await discoverProviderModels({
      getConnections: async () => [
        { provider: "openrouter", isActive: true },
      ],
      fetchModels: async () => {
        throw new Error("OpenRouter unavailable");
      },
      getStaticModels: () => [
        { id: "static-chat", name: "Static Chat" },
        { id: "static-embedding", type: "embedding" },
      ],
      getAliases: async () => ({
        kimi: "openrouter/moonshotai/kimi-k3",
      }),
      getCustomModels: async () => [
        {
          providerAlias: "openrouter",
          id: "custom-chat",
          name: "Custom Chat",
          type: "llm",
        },
        {
          providerAlias: "openrouter",
          id: "custom-image",
          type: "image",
        },
      ],
      getProviderAlias: (provider) => provider,
    });

    expect(result).toEqual({
      models: [
        {
          provider: "openrouter",
          id: "static-chat",
          name: "Static Chat",
          source: "static",
        },
        {
          provider: "openrouter",
          id: "moonshotai/kimi-k3",
          name: "kimi",
          source: "alias",
        },
        {
          provider: "openrouter",
          id: "custom-chat",
          name: "Custom Chat",
          source: "custom",
        },
      ],
      diagnostics: [
        {
          provider: "openrouter",
          code: "live-model-discovery-failed",
          message: "OpenRouter unavailable",
        },
      ],
    });
  });

  test("builds an OpenAI model list with the same picker-safe Kimi ID", () => {
    expect(
      buildModelsResponse(
        [
          {
            provider: "openrouter",
            id: "moonshotai/kimi-k3",
            name: "Kimi K3",
          },
        ],
        { createdAt: 123 },
      ),
    ).toEqual({
      object: "list",
      data: [
        {
          id: "openrouter/moonshotai-kimi-k3",
          object: "model",
          created: 123,
          owned_by: "voidRoute",
        },
      ],
    });
  });
});
