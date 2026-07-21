import chalk from "chalk";

import {
  getCodexIntegrationStatus,
  restoreCodexIntegration,
  syncCodexIntegration,
} from "../codex/integration.js";
import { getCodexPaths } from "../codex/paths.js";
import { BaseAdapter } from "./BaseAdapter.js";

export class CodexAdapter extends BaseAdapter {
  constructor({ paths = getCodexPaths() } = {}) {
    super("codex", "OpenAI Codex");
    this.paths = paths;
  }

  resolveConfigPath() {
    return [this.paths.config];
  }

  async detectStatus() {
    try {
      return (await getCodexIntegrationStatus({ paths: this.paths })).connected
        ? "connected"
        : null;
    } catch {
      return null;
    }
  }

  async resetConfig() {
    const result = await restoreCodexIntegration({ paths: this.paths });
    if (result.conflicts.length > 0) {
      console.log(
        chalk.yellow(
          `  Codex reset paused because these files changed after setup: ${result.conflicts.join(", ")}`,
        ),
      );
      return result;
    }

    console.log(
      result.restored
        ? chalk.green("  voidRoute's Codex integration was restored.")
        : chalk.gray("  No managed voidRoute Codex integration was found."),
    );
    if (result.restartRequired) {
      console.log(chalk.yellow("  Restart Codex to reload its model catalog."));
    }
    return result;
  }

  async applyConfig(model, endpoint) {
    const result = await syncCodexIntegration({
      defaultModel: model,
      baseUrl: endpoint,
      paths: this.paths,
    });
    console.log(
      chalk.green(
        `  Codex configured with ${result.routedModelCount} voidRoute picker models.`,
      ),
    );
    console.log(chalk.gray(`     Default: ${result.configuredModel}`));
    if (result.diagnostics.length > 0) {
      console.log(
        chalk.yellow(
          `  ${result.diagnostics.length} provider model list(s) used fallback data.`,
        ),
      );
    }
    if (result.collisions.length > 0) {
      console.log(
        chalk.yellow(
          `  ${result.collisions.length} ambiguous picker alias(es) were skipped.`,
        ),
      );
    }
    console.log(chalk.yellow("  Restart Codex to load the updated model picker."));
    return result;
  }
}
