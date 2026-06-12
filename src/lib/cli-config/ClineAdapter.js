import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';

export class ClineAdapter extends BaseAdapter {
  constructor() { super('cline', 'Cline'); }
  resolveConfigPath() {
    const home = os.homedir();
    return [path.join(home, '.cline', 'data', 'globalState.json')];
  }
  detectStatus() {
    try {
      const paths = this.resolveConfigPath();
      const found = paths.find(p => fs.existsSync(p));
      if (!found) return null;
      const s = JSON.parse(fs.readFileSync(found, 'utf8'));
      return (s?.actModeApiProvider === 'openai' && s?.openAiBaseUrl?.includes('localhost')) ? 'connected' : null;
    } catch (e) { return null; }
  }
  resetConfig() {
    const clineDataDir = path.join(os.homedir(), '.cline', 'data');
    const globalStatePath = path.join(clineDataDir, 'globalState.json');
    const secretsPath = path.join(clineDataDir, 'secrets.json');
    try {
      if (fs.existsSync(globalStatePath)) {
        let gs = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
        if (gs.actModeApiProvider === 'openai') {
          delete gs.openAiBaseUrl;
          delete gs.openAiModelId;
          delete gs.planModeOpenAiModelId;
          gs.actModeApiProvider = 'cline';
          gs.planModeApiProvider = 'cline';
        }
        fs.writeFileSync(globalStatePath, JSON.stringify(gs, null, 2));
      }
      if (fs.existsSync(secretsPath)) {
        let sec = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        delete sec.openAiApiKey;
        fs.writeFileSync(secretsPath, JSON.stringify(sec, null, 2));
      }
      console.log(chalk.green(`  ✅ voidRoute config removed from Cline.`));
    } catch (e) { console.log(chalk.red(`  ❌ ${e.message}`)); }
  }
  applyConfig(model, endpoint, endpointNoV1) {
    const clineDataDir = path.join(os.homedir(), '.cline', 'data');
    const globalStatePath = path.join(clineDataDir, 'globalState.json');
    const secretsPath = path.join(clineDataDir, 'secrets.json');
    try {
      if (!fs.existsSync(clineDataDir)) fs.mkdirSync(clineDataDir, { recursive: true });
      let gs = {};
      if (fs.existsSync(globalStatePath)) { try { gs = JSON.parse(fs.readFileSync(globalStatePath, 'utf8')); } catch (e) {} }
      gs.actModeApiProvider = 'openai';
      gs.planModeApiProvider = 'openai';
      gs.openAiBaseUrl = endpointNoV1;
      gs.openAiModelId = model;
      gs.planModeOpenAiModelId = model;
      fs.writeFileSync(globalStatePath, JSON.stringify(gs, null, 2));
      
      let sec = {};
      if (fs.existsSync(secretsPath)) { try { sec = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (e) {} }
      sec.openAiApiKey = 'sk_voidRoute';
      fs.writeFileSync(secretsPath, JSON.stringify(sec, null, 2));
      
      console.log(chalk.green(`  ✅ Successfully updated Cline config.`));
      console.log(chalk.gray(`     ${globalStatePath}`));
    } catch (e) { console.log(chalk.red(`  ❌ Failed to write config: ${e.message}`)); }
  }
}
