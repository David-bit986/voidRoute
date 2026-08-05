import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';
import {
  getCatalogPath,
  getCodexHome,
  getStatePath,
  LIFECYCLE_MARKER,
} from './CodexCatalog.js';
import { CodexLifecycle } from './CodexLifecycle.js';

export class CodexAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('codex', 'OpenAI Codex');
    this.lifecycle = new CodexLifecycle(options);
  }

  resolveConfigPath() {
    return [path.join(getCodexHome(), 'config.toml')];
  }

  getConfigPath() {
    return path.join(getCodexHome(), 'config.toml');
  }

  detectStatus() {
    try {
      if (fs.existsSync(getStatePath())) {
        const state = JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
        if (state?.owner?.marker === LIFECYCLE_MARKER && state.status === 'applied') return 'connected';
      }
      return null;
    } catch {
      return null;
    }
  }

  resetConfig() {
    try {
      const result = this.lifecycle.reset();
      if (result.reset) console.log(chalk.green('  ✅ voidRoute config removed from Codex.'));
      else console.log(chalk.gray('  No voidRoute Codex lifecycle state found.'));
      return result;
    } catch (error) {
      console.log(chalk.red(`  ❌ ${error.message}`));
      return { reset: false, error };
    }
  }

  applyConfig(model, endpoint, endpointNoV1, providerModelsList = [], allModelsForProvider = null, defaultModelForTool = null) {
    try {
      const result = this.lifecycle.apply({
        model,
        endpoint,
        endpointNoV1,
        providerModelsList,
        allModelsForProvider,
        defaultModelForTool,
      });
      console.log(chalk.green('  ✅ Codex configured with OpenCodex multi-model routing via voidRoute.'));
      if (result.modelIds.length > 1) {
        console.log(chalk.cyan(`  📦 Registered ${result.modelIds.length} models in ${path.basename(result.catalogPath)}.`));
      }
      console.log(chalk.cyan(`  📦 Refreshed Codex models cache (models_cache.json) with ${result.modelIds.length} models.`));
      console.log(chalk.cyan('  ℹ️  Restart Codex (close and reopen) then select models from the model picker.'));
      return result;
    } catch (error) {
      console.log(chalk.red(`  ❌ Failed to write config: ${error.message}`));
      return { applied: false, error };
    }
  }
}
