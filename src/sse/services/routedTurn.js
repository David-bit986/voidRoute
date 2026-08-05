import { clearAccountError } from "./auth.js";
import { getSettings } from "#lib/db/index.js";
import { getModelInfo, getComboModels } from "./model.js";
import { handleChatCore } from "#open-sse/handlers/chatCore.js";
import { handleComboChat } from "#open-sse/services/combo.js";
import { errorResponse } from "#open-sse/utils/error.js";
import { HTTP_STATUS } from "#open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "#open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials } from "./tokenRefresh.js";
import { ConnectionPool } from "./ConnectionPool.js";

const productionDependencies = {
  resolveModel: getModelInfo,
  resolveCombo: getComboModels,
  getSettings,
  createPool: (provider, model) => new ConnectionPool(provider, model),
  executeCore: handleChatCore,
  handleCombo: handleComboChat,
  errorResponse,
  detectFormatByEndpoint,
  updateProviderCredentials,
  clearAccountError,
  log,
};

/**
 * Create the model-routing turn used after chat request admission.
 * Dependencies are injectable so routing can be tested without provider
 * executors, credentials, or the database.
 */
export function createRoutedTurn(overrides = {}) {
  const dependencies = { ...productionDependencies, ...overrides };

  async function handleSingleModel(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
    const modelInfo = await dependencies.resolveModel(modelStr);

    // A model without a provider may be a configured combo.
    if (!modelInfo.provider) {
      const comboModels = await dependencies.resolveCombo(modelStr);
      if (comboModels) {
        const chatSettings = await dependencies.getSettings();
        const comboStrategies = chatSettings.comboStrategies || {};
        const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
        const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
        const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;

        dependencies.log.info(
          "CHAT",
          `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
        );

        return dependencies.handleCombo({
          body,
          models: comboModels,
          handleSingleModel: (nextBody, nextModel) =>
            handleSingleModel(nextBody, nextModel, clientRawRequest, request, apiKey),
          log: dependencies.log,
          comboName: modelStr,
          comboStrategy,
          comboStickyLimit,
        });
      }

      dependencies.log.warn("CHAT", "Invalid model format", { model: modelStr });
      return dependencies.errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
    }

    const { provider, model } = modelInfo;

    if (modelStr !== `${provider}/${model}`) {
      dependencies.log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
    } else {
      dependencies.log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
    }

    const userAgent = request?.headers?.get("user-agent") || "";
    const pool = dependencies.createPool(provider, model);

    return pool.execute(async (refreshedCredentials, credentials) => {
      const chatSettings = await dependencies.getSettings();
      const providerThinking = (chatSettings.providerThinking || {})[provider] || null;

      return await dependencies.executeCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log: dependencies.log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: !!chatSettings.rtkEnabled,
        cavemanEnabled: !!chatSettings.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        providerThinking,
        // Detect source format by endpoint + body.
        sourceFormatOverride: request?.url
          ? dependencies.detectFormatByEndpoint(new URL(request.url).pathname, body)
          : null,
        onCredentialsRefreshed: async (newCreds) => {
          await dependencies.updateProviderCredentials(credentials.connectionId, {
            accessToken: newCreds.accessToken,
            refreshToken: newCreds.refreshToken,
            providerSpecificData: newCreds.providerSpecificData,
            testStatus: "active",
          });
        },
        onRequestSuccess: async () => {
          await dependencies.clearAccountError(credentials.connectionId, credentials, model);
        },
      });
    });
  }

  return function routeRoutedTurn({ body, modelStr, clientRawRequest = null, request = null, apiKey = null }) {
    return handleSingleModel(body, modelStr, clientRawRequest, request, apiKey);
  };
}

export const routeRoutedTurn = createRoutedTurn();
