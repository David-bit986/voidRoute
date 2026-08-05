import {
  extractApiKey, isValidApiKey,
  clearAccountError,
} from "../services/auth.js";
import { getSettings } from "#lib/db/index.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleTtsCore } from "#open-sse/handlers/ttsCore.js";
import { errorResponse } from "#open-sse/utils/error.js";
import { HTTP_STATUS } from "#open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "#shared/constants/providers";
import { handleComboChat } from "#open-sse/services/combo.js";
import { ConnectionPool } from "../services/ConnectionPool.js";
import * as log from "../utils/logger.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || "mp3"; // mp3 (default) | json
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  const settings = await getSettings();
  if (settings.requireApiKey) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelTts(b, m, responseFormat, language),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language);
}

async function handleSingleModelTts(body, modelStr, responseFormat, language) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — credential + refresh + fallback via shared ConnectionPool
  const pool = new ConnectionPool(provider, model, {
    logLabel: "TTS",
    onSuccess: async (credentials) => {
      await clearAccountError(credentials.connectionId, credentials, model);
    },
  });

  return pool.execute(async (refreshedCredentials) => {
    return await handleTtsCore({ provider, model, input: body.input, credentials: refreshedCredentials, responseFormat, language });
  });
}
