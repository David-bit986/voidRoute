import { buildRoutedModelMap } from "./codex/modelMap.js";
import {
  getModelsByProviderId,
} from "../../open-sse/config/providerModels.js";
import { PROVIDERS as PROVIDER_ENDPOINTS } from "../../open-sse/config/providers.js";
import { getProviderAlias as resolveProviderAlias } from "../shared/constants/providers.js";

const BEARER_MODEL_ENDPOINTS = {
  openai: "https://api.openai.com/v1/models",
  deepseek: "https://api.deepseek.com/models",
  siliconflow: "https://api.siliconflow.cn/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  together: "https://api.together.xyz/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
};

function normalizeProviderModel(model) {
  if (typeof model === "string") {
    return { id: model, name: model };
  }

  const id = model?.id || model?.name;
  if (!id) {
    return null;
  }

  return {
    id,
    name: model.name || id,
    ...(model.type ? { type: model.type } : {}),
  };
}

export async function fetchProviderModels(
  providerId,
  connection,
  {
    fetchImpl = fetch,
    timeoutMs = 5000,
    providerEndpoints = PROVIDER_ENDPOINTS,
    getProviderNode,
  } = {},
) {
  if (!connection) {
    return [];
  }

  let url;
  const headers = { Accept: "application/json" };

  if (BEARER_MODEL_ENDPOINTS[providerId]) {
    url = BEARER_MODEL_ENDPOINTS[providerId];
    if (connection.apiKey) {
      headers.Authorization = `Bearer ${connection.apiKey}`;
    }
  } else if (providerId === "openrouter") {
    url = "https://openrouter.ai/api/v1/models";
    if (connection.apiKey) {
      headers.Authorization = `Bearer ${connection.apiKey}`;
    }
  } else if (providerId === "gemini") {
    const apiKey = connection.apiKey || connection.accessToken;
    if (apiKey) {
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    }
  } else if (providerId === "ollama") {
    url = "http://localhost:11434/api/tags";
  } else if (providerId === "anthropic") {
    url = "https://api.anthropic.com/v1/models";
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    let baseUrl =
      providerEndpoints[providerId]?.baseUrl ??
      connection.providerSpecificData?.baseUrl;
    if (!baseUrl && providerId.startsWith("openai-compatible-")) {
      const loadProviderNode =
        getProviderNode ??
        (await import("./localDb.js")).getProviderNodeById;
      const node = await loadProviderNode(providerId);
      baseUrl = node?.baseUrl;
    }
    baseUrl = baseUrl?.replace(/\/$/, "");

    if (baseUrl?.endsWith("/chat/completions")) {
      baseUrl = baseUrl.replace(/\/chat\/completions$/, "");
    } else if (baseUrl?.endsWith("/messages")) {
      baseUrl = baseUrl.replace(/\/messages$/, "");
    }

    if (baseUrl?.endsWith("/v1")) {
      url = `${baseUrl}/models`;
    } else if (baseUrl?.includes("/v1/")) {
      url = `${baseUrl.split("/v1/")[0]}/v1/models`;
    } else if (baseUrl) {
      url = `${baseUrl}/models`;
    }

    if (connection.apiKey && connection.apiKey !== "local-no-key") {
      headers.Authorization = `Bearer ${connection.apiKey}`;
    }
  }

  if (!url) {
    return [];
  }

  let response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  if (providerId === "ollama") {
    return Array.isArray(body?.models)
      ? body.models.map((model) => ({ id: model.name, name: model.name }))
      : [];
  }

  if (providerId === "gemini") {
    return Array.isArray(body?.models)
      ? body.models
          .filter((model) => model.name?.startsWith("models/"))
          .map((model) => {
            const id = model.name.slice("models/".length);
            return { id, name: model.displayName || id };
          })
      : [];
  }

  const providerModels = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : [];

  return providerModels.map(normalizeProviderModel).filter(Boolean);
}

export async function discoverProviderModels(options = {}) {
  let {
    getConnections,
    fetchModels = fetchProviderModels,
    getStaticModels = getModelsByProviderId,
    getAliases,
    getCustomModels,
    getProviderAlias = resolveProviderAlias,
  } = options;

  if (!getConnections || !getAliases || !getCustomModels) {
    const localDb = await import("./localDb.js");
    getConnections ??= localDb.getProviderConnections;
    getAliases ??= localDb.getModelAliases;
    getCustomModels ??= localDb.getCustomModels;
  }

  const connections = await getConnections({ isActive: true });
  const aliases = await getAliases();
  const customModels = await getCustomModels();
  const activeByProvider = new Map();

  for (const connection of connections) {
    if (connection.isActive !== false && !activeByProvider.has(connection.provider)) {
      activeByProvider.set(connection.provider, connection);
    }
  }

  const models = [];
  const diagnostics = [];
  const seen = new Set();

  const addModel = (provider, model, source) => {
    if (!model?.id || (model.type && model.type !== "llm")) {
      return;
    }

    const key = `${provider}\0${model.id}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    models.push({
      provider,
      id: model.id,
      name: model.name || model.id,
      source,
    });
  };

  for (const [provider, connection] of activeByProvider) {
    const providerAlias = getProviderAlias(provider);
    let discovered;

    try {
      discovered = await fetchModels(provider, connection);
      if (discovered.length === 0) {
        throw new Error("No models returned");
      }
    } catch (error) {
      diagnostics.push({
        provider,
        code: "live-model-discovery-failed",
        message: error instanceof Error ? error.message : String(error),
      });
      discovered = getStaticModels(provider);
    }

    const discoverySource = diagnostics.some(
      (diagnostic) => diagnostic.provider === provider,
    )
      ? "static"
      : "live";

    for (const model of discovered) {
      addModel(providerAlias, model, discoverySource);
    }

    for (const [alias, selector] of Object.entries(aliases)) {
      const separatorIndex = selector.indexOf("/");
      if (separatorIndex <= 0) {
        continue;
      }

      const selectorProvider = selector.slice(0, separatorIndex);
      if (selectorProvider !== provider && selectorProvider !== providerAlias) {
        continue;
      }

      addModel(
        providerAlias,
        { id: selector.slice(separatorIndex + 1), name: alias },
        "alias",
      );
    }

    for (const model of customModels) {
      if (
        model.providerAlias === provider ||
        model.providerAlias === providerAlias
      ) {
        addModel(providerAlias, model, "custom");
      }
    }
  }

  return { models, diagnostics };
}

export function buildModelsResponse(
  discoveredModels,
  { createdAt = Math.floor(Date.now() / 1000) } = {},
) {
  const { models } = buildRoutedModelMap(discoveredModels);

  return {
    object: "list",
    data: Object.keys(models).map((id) => ({
      id,
      object: "model",
      created: createdAt,
      owned_by: "voidRoute",
    })),
  };
}
