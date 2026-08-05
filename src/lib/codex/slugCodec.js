export function encodeRoutedModelId(modelId) {
  return modelId.replaceAll("/", "-");
}

export function routedSlug(provider, modelId) {
  return `${provider}/${encodeRoutedModelId(modelId)}`;
}

export function decodeRoutedModelId(requested, knownIds) {
  let aliasMatch;

  for (const modelId of knownIds) {
    if (modelId === requested) {
      return requested;
    }

    if (
      modelId.includes("/") &&
      encodeRoutedModelId(modelId) === requested
    ) {
      if (aliasMatch !== undefined && aliasMatch !== modelId) {
        return requested;
      }

      aliasMatch = modelId;
    }
  }

  return aliasMatch ?? requested;
}

export function slugEquals(stored, provider, modelId) {
  return (
    stored === `${provider}/${modelId}` ||
    stored === routedSlug(provider, modelId)
  );
}
