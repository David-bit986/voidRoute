import { getProviderAlias, resolveProviderAlias } from "./aliases.js";

export const NON_CHAT_MODEL_TYPES = new Set([
  "image",
  "embedding",
  "tts",
  "stt",
  "video",
]);

const CHAT_MODEL_TYPES = new Set(["chat", "llm"]);
const CAPABILITY_TYPE_ALIASES = {
  audio: "stt",
  embedding: "embedding",
  image: "image",
  image_generation: "image",
  speech: "tts",
  stt: "stt",
  text2img: "image",
  text_embedding: "embedding",
  tts: "tts",
  video: "video",
};

function normalizeValues(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeValues);
  if (typeof value === "string" && value) return [value.toLowerCase()];
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, enabled]) => enabled)
      .flatMap(([key]) => normalizeValues(key));
  }
  return [];
}

function canonicalCapability(value) {
  return CAPABILITY_TYPE_ALIASES[value] || value;
}

/**
 * Parse a provider/model reference without splitting nested model IDs.
 * The first slash is the provider boundary; everything after it is the model.
 */
export function parseModelReference(modelReference) {
  if (!modelReference) {
    return { provider: null, model: null, isAlias: false, providerAlias: null };
  }

  const value = String(modelReference);
  const firstSlash = value.indexOf("/");
  if (firstSlash === -1) {
    return {
      provider: null,
      model: value,
      isAlias: true,
      providerAlias: null,
    };
  }

  const providerAlias = value.slice(0, firstSlash);
  return {
    provider: resolveProviderAlias(providerAlias),
    model: value.slice(firstSlash + 1),
    isAlias: false,
    providerAlias,
  };
}

/**
 * Format a parsed reference using a provider's display alias.
 * Parsed references retain their original prefix by default so parsing and
 * formatting is lossless, including nested model IDs.
 */
export function formatModelReference(reference, modelOrOptions, maybeOptions) {
  const isObjectReference = reference && typeof reference === "object";
  const value = isObjectReference
    ? reference
    : { provider: reference, model: modelOrOptions };
  const options = isObjectReference ? (modelOrOptions || {}) : (maybeOptions || {});

  if (value.model === null || value.model === undefined) return null;

  const model = String(value.model);
  const providerValue = value.provider ?? value.providerAlias;
  if (providerValue === null || providerValue === undefined) return model;

  const provider = resolveProviderAlias(providerValue);
  const prefix = options.preserveInputAlias !== false && value.providerAlias !== null && value.providerAlias !== undefined
    ? value.providerAlias
    : getProviderAlias(provider);
  return `${prefix}/${model}`;
}

/** Classify a model entry for routing and model-list projections. */
export function classifyModel(model) {
  const entry = model && typeof model === "object" ? model : {};
  const declaredTypes = normalizeValues(entry.type);
  const declaredCapabilities = normalizeValues(entry.capabilities);
  const explicitChat = declaredTypes.some((type) => CHAT_MODEL_TYPES.has(type));
  const explicitNonChat = declaredTypes.find((type) => NON_CHAT_MODEL_TYPES.has(type));
  const inferredNonChat = declaredTypes.length === 0
    ? declaredCapabilities.map(canonicalCapability).find((type) => NON_CHAT_MODEL_TYPES.has(type))
    : null;
  const type = declaredTypes.find((candidate) => CHAT_MODEL_TYPES.has(candidate))
    || explicitNonChat
    || inferredNonChat
    || declaredTypes[0]
    || "llm";
  const isChat = explicitChat || (!explicitNonChat && !inferredNonChat);
  const capabilities = [...new Set([
    ...declaredTypes,
    ...declaredCapabilities,
    canonicalCapability(type),
    ...(isChat ? ["chat"] : []),
  ])];

  return {
    type,
    types: declaredTypes,
    capabilities,
    isChat,
    isNonChat: !isChat,
  };
}

export function getModelType(model) {
  return classifyModel(model).type;
}

export function getModelCapabilities(model) {
  return classifyModel(model).capabilities;
}

export function hasModelCapability(model, capability) {
  const requested = String(capability || "").toLowerCase();
  const capabilities = getModelCapabilities(model);
  return capabilities.includes(requested) || capabilities.includes(canonicalCapability(requested));
}

export function isChatModel(model) {
  return classifyModel(model).isChat;
}

export function isModelType(model, type) {
  const requested = String(type || "").toLowerCase();
  const classification = classifyModel(model);
  return classification.type === requested || canonicalCapability(classification.type) === canonicalCapability(requested);
}

export function classifyModelType(model) {
  return getModelType(model);
}

export function classifyModelCapabilities(model) {
  return getModelCapabilities(model);
}
