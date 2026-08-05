// Re-export from open-sse with localDb integration
import { getModelAliases, getProviderNodes, getCombos } from "#lib/db/index.js";
import {
  formatModelReference,
  parseModel as parseModelCore,
  resolveModelAliasFromMap,
  getModelInfoCore,
} from "#open-sse/services/model.js";
import { getComboModelsFromData } from "#open-sse/services/combo.js";

export { formatModelReference };

export function parseModel(modelStr) {
  return parseModelCore(modelStr);
}

/**
 * Resolve a combo name to its list of member models.
 * Returns null if the name is not a combo.
 */
export async function getComboModels(modelStr) {
  if (!modelStr || typeof modelStr !== "string" || modelStr.includes("/")) return null;
  const combos = await getCombos();
  return getComboModelsFromData(modelStr, combos);
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
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
