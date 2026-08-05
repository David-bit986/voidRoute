export async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    let cost = 0;
    const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
    const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
    cost += nonCachedInput * (pricing.input / 1000000);

    if (cachedTokens > 0) {
      const cachedRate = pricing.cached || pricing.input;
      cost += cachedTokens * (cachedRate / 1000000);
    }

    const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
    cost += outputTokens * (pricing.output / 1000000);

    const reasoningTokens = tokens.reasoning_tokens || 0;
    if (reasoningTokens > 0) {
      const rate = pricing.reasoning || pricing.output;
      cost += reasoningTokens * (rate / 1000000);
    }

    const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
    if (cacheCreationTokens > 0) {
      const rate = pricing.cache_creation || pricing.input;
      cost += cacheCreationTokens * (rate / 1000000);
    }

    return cost;
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}
