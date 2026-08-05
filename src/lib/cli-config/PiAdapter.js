import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';

export class PiAdapter extends BaseAdapter {
  constructor() { super('pi', 'Pi Agent'); }
  resolveConfigPath() {
    const home = os.homedir();
    return [path.join(home, '.pi', 'agent', 'models.json')];
  }
  detectStatus() {
    try {
      const paths = this.resolveConfigPath();
      const found = paths.find(p => fs.existsSync(p));
      if (!found) return null;
      const s = JSON.parse(fs.readFileSync(found, 'utf8'));
      return s?.providers?.['voidRoute'] ? 'connected' : null;
    } catch (e) { return null; }
  }
  resetConfig() {
    const modelsPath = this.getConfigPath();
    const piDir = path.dirname(modelsPath);
    const settingsPath = path.join(piDir, 'settings.json');
    try {
      if (fs.existsSync(modelsPath)) {
        let m = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
        if (m.providers) delete m.providers['voidRoute'];
        fs.writeFileSync(modelsPath, JSON.stringify(m, null, 2));
      }
      if (fs.existsSync(settingsPath)) {
        let s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (s.defaultProvider === 'voidRoute') {
          delete s.defaultProvider;
          delete s.defaultModel;
        }
        fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
      }
      console.log(chalk.green(`  ✅ voidRoute config removed from Pi Agent.`));
    } catch (e) { console.log(chalk.red(`  ❌ ${e.message}`)); }
  }
  applyConfig(model, endpoint, endpointNoV1, providerModelsList = [], allModelsForProvider, defaultModelForTool, allModelsForPi) {
    const modelsPath = this.getConfigPath();
    const piDir = path.dirname(modelsPath);
    const settingsPath = path.join(piDir, 'settings.json');
    try {
      if (!fs.existsSync(piDir)) fs.mkdirSync(piDir, { recursive: true });
      
      let modelsData = {};
      if (fs.existsSync(modelsPath)) {
        try { modelsData = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); } catch (e) { }
      }
      if (!modelsData.providers) modelsData.providers = {};
      
      let piModels = [];
      let finalModel = model;

      if (allModelsForPi && providerModelsList.length > 0) {
        for (const m of providerModelsList) {
          if (!piModels.find(x => x.id === m.id)) {
            piModels.push({ id: m.id, name: m.name || m.id });
          }
        }
        finalModel = defaultModelForTool || model;
        console.log(chalk.cyan(`  📦 Registered ${piModels.length} models for Pi Agent`));
      } else {
        piModels.push({ id: model, name: model });
      }

      modelsData.providers['voidRoute'] = {
        baseUrl: endpoint,
        apiKey: "sk_voidRoute",
        api: "openai-completions",
        models: piModels,
      };
      fs.writeFileSync(modelsPath, JSON.stringify(modelsData, null, 2));
      
      let settingsData = {};
      if (fs.existsSync(settingsPath)) {
        try { settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { }
      }
      settingsData.defaultProvider = 'voidRoute';
      settingsData.defaultModel = finalModel;
      fs.writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2));
      
      console.log(chalk.green(`  ✅ Successfully updated Pi Agent config:`));
      console.log(chalk.gray(`     ${modelsPath}`));
      console.log(chalk.gray(`     ${settingsPath}`));
      console.log(chalk.gray(`     Default model: ${finalModel}`));
    } catch (e) { console.log(chalk.red(`  ❌ Failed to write config: ${e.message}`)); }
  }
}
