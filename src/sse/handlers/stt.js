import {
  extractApiKey, isValidApiKey,
  clearAccountError,
} from "../services/auth.js";
import { getSettings } from "#lib/db/index.js";
import { getModelInfo } from "../services/model.js";
import { handleSttCore } from "#open-sse/handlers/sttCore.js";
import { errorResponse } from "#open-sse/utils/error.js";
import { HTTP_STATUS } from "#open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "#shared/constants/providers";
import { ConnectionPool } from "../services/ConnectionPool.js";
import * as log from "../utils/logger.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  const settings = await getSettings();
  if (settings.requireApiKey) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({ provider, model, formData });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — credential + refresh + fallback via shared ConnectionPool
  const pool = new ConnectionPool(provider, model, {
    logLabel: "STT",
    onSuccess: async (credentials) => {
      await clearAccountError(credentials.connectionId, credentials, model);
    },
  });

  return pool.execute(async (refreshedCredentials) => {
    return await handleSttCore({ provider, model, formData, credentials: refreshedCredentials });
  });
}
