import { getProviderCredentials, markAccountUnavailable, clearAccountError } from "./auth.js";
import { checkAndRefreshToken, updateProviderCredentials } from "./tokenRefresh.js";
import { getProjectIdForConnection } from "#open-sse/services/projectId.js";
import * as log from "../utils/logger.js";
import { HTTP_STATUS } from "#open-sse/config/runtimeConfig.js";
import { unavailableResponse, errorResponse } from "#open-sse/utils/error.js";

export class ConnectionPool {
  constructor(provider, model) {
    this.provider = provider;
    this.model = model;
    this.excludeConnectionIds = new Set();
    this.lastError = null;
    this.lastStatus = null;
  }

  async execute(operation) {
    while (true) {
      const credentials = await getProviderCredentials(this.provider, this.excludeConnectionIds, this.model);

      if (!credentials || credentials.allRateLimited) {
        if (credentials?.allRateLimited) {
          const errorMsg = this.lastError || credentials.lastError || "Unavailable";
          const status = this.lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
          log.warn("CHAT", `[${this.provider}/${this.model}] ${errorMsg} (${credentials.retryAfterHuman})`);
          return unavailableResponse(status, `[${this.provider}/${this.model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
        }
        if (this.excludeConnectionIds.size === 0) {
          log.warn("AUTH", `No active credentials for provider: ${this.provider}`);
          return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${this.provider}`);
        }
        log.warn("CHAT", "No more accounts available", { provider: this.provider });
        return errorResponse(this.lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, this.lastError || "All accounts unavailable");
      }

      log.info("AUTH", `\x1b[32mUsing ${this.provider} account: ${credentials.connectionName}\x1b[0m`);

      const refreshedCredentials = await checkAndRefreshToken(this.provider, credentials);

      if ((this.provider === "antigravity" || this.provider === "gemini-cli") && !refreshedCredentials.projectId) {
        const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
        if (pid) {
          refreshedCredentials.projectId = pid;
          updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
        }
      }

      const result = await operation(refreshedCredentials, credentials);

      if (result.success) {
        return result.response;
      }

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId, 
        result.status, 
        result.error, 
        this.provider, 
        this.model, 
        result.resetsAtMs
      );

      if (shouldFallback) {
        log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
        this.excludeConnectionIds.add(credentials.connectionId);
        this.lastError = result.error;
        this.lastStatus = result.status;
        continue;
      }

      return result.response;
    }
  }
}