import { routedSlug } from "./slugCodec.js";

export function buildRoutedModelMap(discoveredModels) {
  const candidatesBySlug = new Map();

  for (const { provider, id } of discoveredModels) {
    const slug = routedSlug(provider, id);
    const candidates = candidatesBySlug.get(slug) ?? new Set();
    candidates.add(id);
    candidatesBySlug.set(slug, candidates);
  }

  const models = {};
  const collisions = [];

  for (const [slug, candidates] of candidatesBySlug) {
    const modelIds = [...candidates].sort();

    if (modelIds.length > 1) {
      collisions.push({ slug, models: modelIds });
      continue;
    }

    const separatorIndex = slug.indexOf("/");
    models[slug] = {
      provider: slug.slice(0, separatorIndex),
      model: modelIds[0],
    };
  }

  collisions.sort((left, right) => left.slug.localeCompare(right.slug));

  return { models, collisions };
}
