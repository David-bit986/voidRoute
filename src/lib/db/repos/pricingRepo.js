import { makeKv, KV_DELETE } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("#shared/constants/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  const { getPricingForModel: resolveConst } = await import("#shared/constants/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  for (const [provider, models] of Object.entries(pricingData)) {
    await pricingKv.merge(provider, (current) => {
      const merged = { ...(current || {}) };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      return merged;
    }, {});
  }
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  if (!model) {
    await pricingKv.remove(provider);
  } else {
    await pricingKv.merge(provider, (current) => {
      const next = { ...(current || {}) };
      delete next[model];
      return Object.keys(next).length === 0 ? KV_DELETE : next;
    }, {});
  }
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
