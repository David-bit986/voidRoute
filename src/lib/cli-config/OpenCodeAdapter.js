import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';
import { getCombos } from '#lib/db/index.js';
import { getProviderAlias } from '#shared/constants/providers.js';

export class OpenCodeAdapter extends BaseAdapter {
  constructor() { super('opencode', 'OpenCode'); }
  resolveConfigPath() {
    const home = os.homedir();
    return [
      path.join(home, '.config', 'opencode', 'opencode.json'),
      path.join(home, '.config', 'opencode-profiles', 'default', 'opencode.json'),
    ];
  }
  detectStatus() {
    try {
      const paths = this.resolveConfigPath();
      const found = paths.find(p => fs.existsSync(p));
      if (!found) return null;
      const s = JSON.parse(fs.readFileSync(found, 'utf8'));
      return s?.provider?.['voidRoute'] ? 'connected' : null;
    } catch (e) { return null; }
  }
  resetConfig() {
    try {
      for (const p of this.resolveConfigPath()) {
        if (fs.existsSync(p)) {
          let s = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (s.provider) delete s.provider['voidRoute'];
          if (s.model?.startsWith('voidRoute/')) delete s.model;
          if (s.agent?.explorer?.model?.startsWith('voidRoute/')) {
            delete s.agent.explorer;
            if (Object.keys(s.agent).length === 0) delete s.agent;
          }
          fs.writeFileSync(p, JSON.stringify(s, null, 2));
        }
      }
      console.log(chalk.green(`  ✅ voidRoute config removed from OpenCode.`));
    } catch (e) { console.log(chalk.red(`  ❌ ${e.message}`)); }
  }
  async applyConfig(model, endpoint, endpointNoV1, providerModelsList = [], allModelsForProvider = null, defaultModelForTool = null, allModelsForPi, isCustomModel) {
    const ocConfigPath = this.getConfigPath();
    const ocDir = path.dirname(ocConfigPath);
    const ocPath = ocConfigPath;
    try {
      let ocSettings = {};
      try { if (fs.existsSync(ocPath)) ocSettings = JSON.parse(fs.readFileSync(ocPath, 'utf8')); } catch (e) { }
      
      let ocModels = {};
      const defaultModel = defaultModelForTool || model;

      // If user chose "all models", register every model from the provider
      if (allModelsForProvider && allModelsForProvider.length > 0) {
        for (const mId of allModelsForProvider) {
          ocModels[mId] = { name: mId, modalities: { input: ["text", "image"], output: ["text"] } };
        }
        console.log(chalk.cyan(`  📦 Registered ${allModelsForProvider.length} models for OpenCode`));
      } else {
        const allCombos = await getCombos().catch(() => []);
        const selectedCombo = allCombos.find(c => c.name === model);

        if (selectedCombo) {
          for (const m of selectedCombo.models) {
            const mId = m.provider ? `${getProviderAlias(m.provider)}/${m.model}` : m.model;
            ocModels[mId] = { name: mId, modalities: { input: ["text", "image"], output: ["text"] } };
          }
        } else {
          ocModels[model] = { name: model, modalities: { input: ["text", "image"], output: ["text"] } };
        }
      }

      if (!ocSettings.provider) ocSettings.provider = {};
      ocSettings.provider['voidRoute'] = {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: endpoint, apiKey: "sk_voidRoute" },
        models: ocModels
      };
      ocSettings.model = `voidRoute/${defaultModel}`;
      if (!ocSettings.agent) ocSettings.agent = {};
      ocSettings.agent.explorer = { description: "Fast explorer subagent", mode: "subagent", model: `voidRoute/${defaultModel}` };
      
      if (!fs.existsSync(ocDir)) fs.mkdirSync(ocDir, { recursive: true });
      fs.writeFileSync(ocPath, JSON.stringify(ocSettings, null, 2));
      console.log(chalk.green(`  ✅ Successfully updated ${ocPath}`));
      console.log(chalk.yellow(`  ⚠️ Note: If OpenCode does not load this config, you might need to manually copy it to your active profile (e.g. ~/.config/opencode-profiles/default/opencode.json)`));
    } catch (e) { console.log(chalk.red(`  ❌ Failed to write config: ${e.message}`)); }
  }
}
