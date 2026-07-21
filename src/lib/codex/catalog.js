import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "./atomicFile.js";
import { buildRoutedModelMap } from "./modelMap.js";
import { slugEquals } from "./slugCodec.js";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function routedInstructions(instructions, modelId) {
  if (typeof instructions !== "string") {
    return instructions;
  }

  return instructions.replace(
    /^You are Codex, an agent based on [^.]+\./,
    `You are Codex, powered by ${modelId} through voidRoute.`,
  );
}

function normalizeRoutedEntry(entry) {
  const openAiOnlyFields = [
    "additional_speed_tiers",
    "service_tier",
    "service_tiers",
    "default_service_tier",
    "model_messages",
    "tool_mode",
    "multi_agent_version",
    "use_responses_lite",
    "supports_websockets",
    "availability_nux",
  ];

  for (const field of openAiOnlyFields) {
    delete entry[field];
  }
  if ("upgrade" in entry) {
    entry.upgrade = null;
  }

  return entry;
}

function hasUsableTemplate(catalog) {
  return (
    Array.isArray(catalog?.models) &&
    catalog.models.some(
      (model) =>
        typeof model?.slug === "string" &&
        !model.slug.includes("/") &&
        typeof model.base_instructions === "string" &&
        model.base_instructions.length > 0,
    )
  );
}

export async function loadCodexCatalogBaseline({
  selectedCatalogPath,
  backupPath,
  modelsCachePath,
  readFileImpl = readFile,
}) {
  const candidates = [selectedCatalogPath, backupPath, modelsCachePath].filter(
    (candidate, index, all) => candidate && all.indexOf(candidate) === index,
  );

  for (const source of candidates) {
    try {
      const catalog = JSON.parse(await readFileImpl(source, "utf8"));
      if (hasUsableTemplate(catalog)) {
        return { catalog, source };
      }
    } catch {
      // Try the next read-only baseline source.
    }
  }

  throw new Error("No usable Codex catalog template was found");
}

export function buildCodexCatalog({
  baseline,
  discoveredModels,
  defaultModel,
}) {
  if (!Array.isArray(baseline?.models) || baseline.models.length === 0) {
    throw new Error("Codex catalog baseline must contain at least one model");
  }

  const template = baseline.models.find(
    (model) =>
      typeof model?.slug === "string" &&
      !model.slug.includes("/") &&
      typeof model.base_instructions === "string" &&
      model.base_instructions.length > 0,
  );
  if (!template) {
    throw new Error("Codex catalog baseline has no usable native template");
  }

  const { models: mappedModels, collisions } =
    buildRoutedModelMap(discoveredModels);
  const routedEntries = [];
  const nativePriorityFloor = Math.min(
    0,
    ...baseline.models
      .map((model) => model?.priority)
      .filter(Number.isInteger),
  );
  const orderedMappedModels = Object.entries(mappedModels).sort(
    ([leftSlug, leftTarget], [rightSlug, rightTarget]) => {
      const leftSelected = slugEquals(
        defaultModel,
        leftTarget.provider,
        leftTarget.model,
      );
      const rightSelected = slugEquals(
        defaultModel,
        rightTarget.provider,
        rightTarget.model,
      );
      if (leftSelected !== rightSelected) {
        return leftSelected ? -1 : 1;
      }
      return leftSlug.localeCompare(rightSlug);
    },
  );
  const routedPriorityStart = nativePriorityFloor - orderedMappedModels.length;

  for (const [index, [slug, target]] of orderedMappedModels.entries()) {
    const entry = cloneJson(template);
    entry.slug = slug;
    entry.display_name = slug;
    entry.description =
      `Routed via voidRoute to ${target.provider}/${target.model}.`;
    entry.priority = routedPriorityStart + index;
    entry.visibility = "list";
    entry.base_instructions = routedInstructions(
      entry.base_instructions,
      target.model,
    );
    routedEntries.push(normalizeRoutedEntry(entry));
  }

  const preservedNativeEntries = cloneJson(baseline.models);
  const ownedSlugs = routedEntries.map((entry) => entry.slug);

  return {
    catalog: { models: [...routedEntries, ...preservedNativeEntries] },
    modelMap: { models: mappedModels },
    manifest: { version: 1, ownedSlugs },
    collisions,
  };
}

function serializeJson(value, label) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const parsed = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} did not serialize to a JSON object`);
  }
  return serialized;
}

export async function writeCodexCatalogArtifacts({
  paths,
  artifacts,
  writeAtomic = writeFileAtomic,
}) {
  const models = artifacts?.catalog?.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("Refusing to write an empty Codex catalog");
  }

  const slugs = models.map((model) => model?.slug);
  if (slugs.some((slug) => typeof slug !== "string" || slug.length === 0)) {
    throw new Error("Refusing to write a Codex catalog with an invalid slug");
  }
  if (new Set(slugs).size !== slugs.length) {
    throw new Error("Refusing to write a Codex catalog with duplicate slugs");
  }
  if (!artifacts?.modelMap?.models || typeof artifacts.modelMap.models !== "object") {
    throw new Error("Refusing to write an invalid Codex model map");
  }

  const catalogJson = serializeJson(artifacts.catalog, "Codex catalog");
  const modelMapJson = serializeJson(artifacts.modelMap, "Codex model map");

  await writeAtomic(paths.catalog, catalogJson);
  await writeAtomic(paths.modelMap, modelMapJson);
}
