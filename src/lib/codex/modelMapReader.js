import { readFile, stat } from "node:fs/promises";

import { getCodexPaths } from "./paths.js";

const cache = new Map();

async function readModelMap(filePath, { readFileImpl, statImpl }) {
  let metadata;
  try {
    metadata = await statImpl(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      cache.delete(filePath);
      return null;
    }
    throw error;
  }

  const cached = cache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === metadata.mtimeMs &&
    cached.size === metadata.size
  ) {
    return cached.modelMap;
  }

  try {
    const parsed = JSON.parse(await readFileImpl(filePath, "utf8"));
    const modelMap = parsed?.models && typeof parsed.models === "object"
      ? parsed
      : null;
    cache.set(filePath, {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      modelMap,
    });
    return modelMap;
  } catch {
    cache.delete(filePath);
    return null;
  }
}

export async function resolveCodexPickerModel(
  requested,
  {
    paths = getCodexPaths(),
    readFileImpl = readFile,
    statImpl = stat,
  } = {},
) {
  const modelMap = await readModelMap(paths.modelMap, {
    readFileImpl,
    statImpl,
  });
  const target = modelMap?.models?.[requested];
  if (
    typeof target?.provider !== "string" ||
    typeof target?.model !== "string"
  ) {
    return null;
  }
  return { provider: target.provider, model: target.model };
}
