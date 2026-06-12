import { prepareClaudeRequest } from "./helpers/claudeHelper.js";
import { cloakClaudeTools } from "../utils/claudeCloaking.js";
import { FORMATS } from "./formats.js";

// Clean seam for provider-specific mutations
export class TranslatorAdapter {
  static applyMutations(body, { targetFormat, provider, credentials, connectionId }) {
    let result = body;

    // Claude format preparation
    if (targetFormat === FORMATS.CLAUDE) {
      const apiKey = credentials?.accessToken || credentials?.apiKey || null;
      result = prepareClaudeRequest(result, provider, apiKey, connectionId);
    }

    // Provider-specific cloaking (e.g., Claude OAuth)
    if (provider === "claude") {
      const apiKey = credentials?.accessToken || credentials?.apiKey || null;
      if (apiKey?.includes("sk-ant-oat")) {
        const { body: cloakedBody, toolNameMap } = cloakClaudeTools(result);
        result = cloakedBody;
        if (toolNameMap?.size > 0) {
          result._toolNameMap = toolNameMap;
        }
      }
    }

    return result;
  }
}
