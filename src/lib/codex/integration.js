import { readFile, rm } from "node:fs/promises";

import { discoverProviderModels } from "../providerModels.js";
import { writeFileAtomic } from "./atomicFile.js";
import {
  buildCodexCatalog,
  loadCodexCatalogBaseline,
  writeCodexCatalogArtifacts,
} from "./catalog.js";
import {
  cleanLegacyCodexAuth,
  injectCodexConfig,
  MANAGED_BASE_URL_MARKER,
  readCodexRootValues,
} from "./configToml.js";
import { migrateLegacyCodexHistory } from "./history.js";
import { buildRestorePlan, createCodexJournal } from "./journal.js";
import { getCodexPaths } from "./paths.js";

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveConfiguredModel(defaultModel, modelMap) {
  if (modelMap.models[defaultModel]) {
    return defaultModel;
  }

  const separatorIndex = defaultModel.indexOf("/");
  if (separatorIndex > 0) {
    const provider = defaultModel.slice(0, separatorIndex);
    const model = defaultModel.slice(separatorIndex + 1);
    const match = Object.entries(modelMap.models).find(
      ([, target]) => target.provider === provider && target.model === model,
    );
    if (match) {
      return match[0];
    }
  }

  throw new Error(`Selected Codex model was not discovered: ${defaultModel}`);
}

async function loadJournal(statePath) {
  const content = await readOptional(statePath);
  if (content === null) {
    return null;
  }
  try {
    const journal = JSON.parse(content);
    return journal?.version === 1 && journal.files ? journal : null;
  } catch {
    return null;
  }
}

async function cleanupLegacyAuth(paths) {
  const content = await readOptional(paths.auth);
  if (content === null) {
    return false;
  }
  const cleaned = cleanLegacyCodexAuth(content);
  if (cleaned.changed) {
    await writeFileAtomic(paths.auth, cleaned.content);
  }
  return cleaned.changed;
}

function journaledBefore(priorJournal, name, currentContent) {
  const entry = priorJournal?.files?.[name];
  return entry && Object.hasOwn(entry, "before")
    ? entry.before
    : currentContent;
}

export async function syncCodexIntegration({
  defaultModel,
  baseUrl,
  paths = getCodexPaths(),
  discoverModels = discoverProviderModels,
}) {
  const configBefore = await readOptional(paths.config);
  const rootValues = readCodexRootValues(configBefore ?? "");
  const selectedCatalogPath =
    rootValues.model_catalog_json &&
    rootValues.model_catalog_json !== paths.catalog
      ? rootValues.model_catalog_json
      : undefined;
  const discovery = await discoverModels();
  if (!Array.isArray(discovery?.models) || discovery.models.length === 0) {
    throw new Error("No active LLM models were discovered for Codex");
  }

  const baselineResult = await loadCodexCatalogBaseline({
    selectedCatalogPath,
    backupPath: paths.backup,
    modelsCachePath: paths.modelsCache,
  });
  const artifacts = buildCodexCatalog({
    baseline: baselineResult.catalog,
    discoveredModels: discovery.models,
    defaultModel,
  });
  const configuredModel = resolveConfiguredModel(defaultModel, artifacts.modelMap);
  const configAfter = injectCodexConfig(configBefore ?? "", {
    model: configuredModel,
    catalogPath: paths.catalog,
    baseUrl,
  });
  const catalogAfter = jsonText(artifacts.catalog);
  const modelMapAfter = jsonText(artifacts.modelMap);
  const catalogBefore = await readOptional(paths.catalog);
  const modelMapBefore = await readOptional(paths.modelMap);
  const priorJournal = await loadJournal(paths.state);

  const journal = createCodexJournal({
    files: {
      config: {
        before: journaledBefore(priorJournal, "config", configBefore),
        after: configAfter,
      },
      catalog: {
        before: journaledBefore(priorJournal, "catalog", catalogBefore),
        after: catalogAfter,
      },
      modelMap: {
        before: journaledBefore(priorJournal, "modelMap", modelMapBefore),
        after: modelMapAfter,
      },
    },
    manifest: artifacts.manifest,
  });

  if ((await readOptional(paths.backup)) === null) {
    await writeFileAtomic(paths.backup, jsonText(baselineResult.catalog));
  }
  await writeFileAtomic(paths.state, jsonText(journal));
  await writeCodexCatalogArtifacts({ paths, artifacts });
  await writeFileAtomic(paths.config, configAfter);
  const historyMigration = await migrateLegacyCodexHistory({ paths });

  return {
    configuredModel,
    routedModelCount: Object.keys(artifacts.modelMap.models).length,
    nativeModelCount: baselineResult.catalog.models.length,
    diagnostics: discovery.diagnostics ?? [],
    collisions: artifacts.collisions,
    historyMigration,
    restartRequired: true,
  };
}

export async function restoreCodexIntegration({ paths = getCodexPaths() } = {}) {
  const journal = await loadJournal(paths.state);
  if (!journal) {
    return {
      restored: false,
      conflicts: [],
      legacyAuthCleaned: await cleanupLegacyAuth(paths),
      restartRequired: false,
    };
  }

  const currentFiles = {
    config: await readOptional(paths.config),
    catalog: await readOptional(paths.catalog),
    modelMap: await readOptional(paths.modelMap),
  };
  const plan = buildRestorePlan(journal, currentFiles);
  if (plan.conflicts.length > 0) {
    return {
      restored: false,
      conflicts: plan.conflicts,
      legacyAuthCleaned: await cleanupLegacyAuth(paths),
      restartRequired: false,
    };
  }

  const filePaths = {
    config: paths.config,
    catalog: paths.catalog,
    modelMap: paths.modelMap,
  };
  for (const name of ["catalog", "modelMap", "config"]) {
    const restoration = plan.restorations[name];
    if (restoration.action === "write") {
      await writeFileAtomic(filePaths[name], restoration.content);
    } else {
      await rm(filePaths[name], { force: true });
    }
  }

  const legacyAuthCleaned = await cleanupLegacyAuth(paths);
  await rm(paths.state, { force: true });
  await rm(paths.backup, { force: true });

  return {
    restored: true,
    conflicts: [],
    legacyAuthCleaned,
    restartRequired: true,
  };
}

export async function getCodexIntegrationStatus({ paths = getCodexPaths() } = {}) {
  const config = await readOptional(paths.config);
  let catalog;
  let modelMap;
  try {
    const catalogContent = await readOptional(paths.catalog);
    const modelMapContent = await readOptional(paths.modelMap);
    catalog = catalogContent === null ? null : JSON.parse(catalogContent);
    modelMap = modelMapContent === null ? null : JSON.parse(modelMapContent);
  } catch {
    catalog = null;
    modelMap = null;
  }

  return inspectCodexIntegration({
    config,
    catalog,
    modelMap,
    catalogPath: paths.catalog,
  });
}

export function inspectCodexIntegration({
  config,
  catalog,
  modelMap,
  catalogPath,
}) {
  const roots = readCodexRootValues(config ?? "");
  const routedModelCount = modelMap?.models && typeof modelMap.models === "object"
    ? Object.keys(modelMap.models).length
    : 0;
  const catalogModelCount = Array.isArray(catalog?.models)
    ? catalog.models.length
    : 0;
  const configuredModel = roots.model;
  const connected = Boolean(
    config?.includes(MANAGED_BASE_URL_MARKER) &&
    roots.openai_base_url &&
    roots.model_catalog_json === catalogPath &&
    configuredModel &&
    modelMap?.models?.[configuredModel] &&
    catalog?.models?.some((model) => model.slug === configuredModel),
  );

  return {
    connected,
    configuredModel,
    routedModelCount,
    catalogModelCount,
  };
}
