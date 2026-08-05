// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  renameCustomModelAlias,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage — live state, writes, reads, cost split by concern
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
} from "./repos/usageState.js";
export { saveRequestUsage } from "./repos/usageWrite.js";
export {
  getUsageHistory, getUsageStats, getChartData, getRecentLogs,
} from "./repos/usageRead.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB — single implementation in ./portable.js
export { exportDb, importDb } from "./portable.js";

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
