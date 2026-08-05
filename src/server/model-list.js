import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProviderConnections } from '#lib/db/index.js';
import { getModelsByProviderId } from '../../open-sse/config/providerModels.js';
import { formatModelReference, isChatModel } from '../shared/constants/modelIdentity.js';

const CODEX_CATALOG_FILENAME = 'voidRoute-catalog.json';

function isRequest(value) {
  return value instanceof Request || (value && typeof value.url === 'string' && typeof value.method === 'string');
}

function getCodexCatalogPath() {
  const configuredHome = process.env.CODEX_HOME?.trim();
  const home = path.resolve(configuredHome || path.join(os.homedir(), '.codex'));
  return path.join(home, CODEX_CATALOG_FILENAME);
}

function readCodexCatalog(filePath = getCodexCatalogPath(), fileSystem = fs) {
  let catalog;
  try {
    catalog = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Codex model catalog ${filePath}: ${error.message}`);
  }
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error(`Codex model catalog ${filePath} must contain a models array`);
  }
  return { models: catalog.models };
}

function isCodexCatalogRequest(request) {
  return request && new URL(request.url).searchParams.has('client_version');
}

export function buildModelList(connections, getProviderModels = getModelsByProviderId, providerPrefixById = null) {
  const models = [];
  const modelIds = new Set();

  for (const connection of connections) {
    if (connection.isActive === false) continue;
    const providerId = connection.provider || connection.providerId;
    if (!providerId) continue;
    const providerModels = getProviderModels(providerId);

    for (const model of providerModels || []) {
      if (!isChatModel(model)) continue;
      const modelId = typeof model === 'string' ? model : model.id;
      if (!modelId) continue;
      const provider = (providerPrefixById && providerPrefixById[providerId]) || providerId;
      const id = formatModelReference({ provider, model: modelId });
      if (modelIds.has(id)) continue;
      modelIds.add(id);
      models.push({ id, object: 'model', created: Date.now(), owned_by: 'voidRoute' });
    }
  }

  return { object: 'list', data: models };
}

export async function getModels(options = {}) {
  const request = isRequest(options) ? options : options.request;
  if (isCodexCatalogRequest(request)) {
    return (options.getCodexCatalog || readCodexCatalog)();
  }

  const {
    getConnections = getProviderConnections,
    getProviderModels = getModelsByProviderId,
    getProviderNodes = async function defaultProviderNodes() {
      const { getProviderNodes } = await import('#lib/db/index.js');
      return getProviderNodes();
    },
  } = isRequest(options) ? {} : options;
  const connections = await getConnections({ isActive: true });
  const nodes = await getProviderNodes();
  const providerPrefixById = Object.fromEntries(
    nodes.map((node) => [node.id, node.prefix || node.name]).filter(([, prefix]) => prefix)
  );
  return buildModelList(connections, getProviderModels, providerPrefixById);
}
