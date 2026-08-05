import {
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getCombos } from "#lib/db/index.js";
import { AI_PROVIDERS, resolveProviderId } from "#shared/constants/providers.js";
import { handleFetchCore } from "#open-sse/handlers/fetch/index.js";
import { errorResponse } from "#open-sse/utils/error.js";
import { HTTP_STATUS } from "#open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "#open-sse/services/combo.js";
import { ConnectionPool } from "../services/ConnectionPool.js";

/**
 * Handle web fetch (URL extraction) request for the SSE/Next.js server.
 * Provider IS the model. Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleFetch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("FETCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const reqUrl = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webFetch)
  const providerInput = body.provider || body.model;
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;

  log.request("POST", `${reqUrl.pathname} | ${providerInput}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("FETCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  if (!targetUrl || typeof targetUrl !== "string") {
    log.warn("FETCH", "Missing url");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: url");
  }

  // Validate URL format
  try {
    new URL(targetUrl);
  } catch {
    log.warn("FETCH", "Invalid URL", { url: targetUrl });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid URL format");
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("FETCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderFetch(b, m, request, apiKey, settings),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderFetch(body, providerInput, request, apiKey, settings);
}

async function handleSingleProviderFetch(body, providerInput, request, apiKey, settings) {
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("FETCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.fetchConfig;
  if (!providerConfig) {
    log.warn("FETCH", "Provider does not support web fetch", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web fetch`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // No-auth fetch path (kept for parity though no current fetch provider sets noAuth)
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleFetchCore({
      url: targetUrl,
      format,
      maxCharacters,
      provider: resolvedProvider.id,
      providerConfig,
      credentials: null,
      log
    });
    if (result.success) {
      return new Response(JSON.stringify(result.data), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed");
  }

  // Credential + fallback loop via shared ConnectionPool
  const pool = new ConnectionPool(providerId, null, { logLabel: "FETCH" });

  return pool.execute(async (refreshedCredentials, credentials) => {
    const result = await handleFetchCore({
      url: targetUrl,
      format,
      maxCharacters,
      provider: resolvedProvider.id,
      providerConfig,
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials);
      }
    });

    if (result.success) {
      return {
        success: true,
        response: new Response(JSON.stringify(result.data), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        })
      };
    }

    return {
      success: false,
      status: result.status,
      error: result.error,
      response: errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed")
    };
  });
}
