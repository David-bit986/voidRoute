// Provider alias to ID mapping lives in the single alias module.
import { resolveProviderAlias } from "#shared/constants/aliases.js";
import {
  classifyModel,
  formatModelReference,
  getModelCapabilities,
  getModelType,
  hasModelCapability,
  isChatModel,
  isModelType,
  parseModelReference,
} from "#shared/constants/modelIdentity.js";
export { resolveProviderAlias };
export {
  classifyModel,
  formatModelReference,
  getModelCapabilities,
  getModelType,
  hasModelCapability,
  isChatModel,
  isModelType,
  parseModelReference,
};

/**
 * Parse model string: "alias/model" or "provider/model" or just alias
 */
export function parseModel(modelStr) {
  return parseModelReference(modelStr);
}

/**
 * Resolve model alias from aliases object
 * Format: { "alias": "provider/model" }
 */
export function resolveModelAliasFromMap(alias, aliases) {
  if (!aliases) return null;

  // Check if alias exists
  const resolved = aliases[alias];
  if (!resolved) return null;

  // Resolved value is "provider/model" format
  if (typeof resolved === "string" && resolved.includes("/")) {
    const parsed = parseModelReference(resolved);
    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  // Or object { provider, model }
  if (typeof resolved === "object" && resolved.provider && resolved.model) {
    return {
      provider: resolveProviderAlias(resolved.provider),
      model: resolved.model,
    };
  }

  return null;
}

/**
 * Get full model info (parse or resolve)
 * @param {string} modelStr - Model string
 * @param {object|function} aliasesOrGetter - Aliases object or async function to get aliases
 */
export async function getModelInfoCore(modelStr, aliasesOrGetter) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  // Get aliases (from object or function)
  const aliases =
    typeof aliasesOrGetter === "function"
      ? await aliasesOrGetter()
      : aliasesOrGetter;

  // Resolve alias
  const resolved = resolveModelAliasFromMap(parsed.model, aliases);
  if (resolved) {
    return resolved;
  }

  // Fallback: infer provider from model name prefix
  return {
    provider: inferProviderFromModelName(parsed.model),
    model: parsed.model,
  };
}

/**
 * Infer provider from model name prefix
 * Used as fallback when no provider prefix or alias is given
 */
function inferProviderFromModelName(modelName) {
  if (!modelName) return "openai";
  const m = modelName.toLowerCase();
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "gemini";
  if (m.startsWith("gpt-")) return "openai";
  if (m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"))
    return "openai";
  if (m.startsWith("deepseek-")) return "openrouter";
  // Default fallback
  return "openai";
}
