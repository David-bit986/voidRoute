// Re-export from open-sse with localDb integration
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "#open-sse/services/model.js";
import { resolveCodexPickerModel } from "#lib/codex/modelMapReader.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const { getModelAliases } = await import("#lib/localDb");
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const pickerModel = await resolveCodexPickerModel(modelStr);
  if (pickerModel) {
    const parsedPickerModel = parseModel(
      `${pickerModel.provider}/${pickerModel.model}`,
    );
    return {
      provider: parsedPickerModel.provider,
      model: parsedPickerModel.model,
    };
  }

  const { getModelAliases, getProviderNodes } = await import("#lib/localDb");
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Always check provider-node prefix matching using original input first
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedOpenAI) {
      return { provider: matchedOpenAI.id, model: parsed.model };
    }

    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedAnthropic) {
      return { provider: matchedAnthropic.id, model: parsed.model };
    }

    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedEmbedding) {
      return { provider: matchedEmbedding.id, model: parsed.model };
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}
