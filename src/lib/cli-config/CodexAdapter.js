import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';

export class CodexAdapter extends BaseAdapter {
  constructor() { super('codex', 'OpenAI Codex'); }
  resolveConfigPath() {
    const home = os.homedir();
    return [path.join(home, '.codex', 'config.toml')];
  }
  detectStatus() {
    try {
      const paths = this.resolveConfigPath();
      const found = paths.find(p => fs.existsSync(p));
      if (!found) return null;
      return fs.readFileSync(found, 'utf8').includes('voidRoute') ? 'connected' : null;
    } catch (e) { return null; }
  }
  resetConfig() {
    const cxDir = path.join(os.homedir(), '.codex');
    const cxConfig = path.join(cxDir, 'config.toml');
    const cxAuth = path.join(cxDir, 'auth.json');
    try {
      if (fs.existsSync(cxConfig)) {
        let toml = fs.readFileSync(cxConfig, 'utf8');
        toml = toml.replace(/\[model_providers\.voidRoute\][\s\S]*?(?=\n\[|$)/g, '');
        if (toml.match(/model_provider\s*=\s*"voidRoute"/)) {
          toml = toml.replace(/model_provider\s*=\s*"voidRoute"/, '');
          toml = toml.replace(/^model\s*=.*$/m, '');
        }
        fs.writeFileSync(cxConfig, toml.replace(/\n{3,}/g, '\n\n').trim() + '\n');
      }
      if (fs.existsSync(cxAuth)) {
        let auth = JSON.parse(fs.readFileSync(cxAuth, 'utf8'));
        if (auth.auth_mode === 'apikey' && auth.OPENAI_API_KEY === 'sk_voidRoute') {
          delete auth.OPENAI_API_KEY;
          delete auth.auth_mode;
        }
        fs.writeFileSync(cxAuth, JSON.stringify(auth, null, 2));
      }
      console.log(chalk.green(`  ✅ voidRoute config removed from Codex.`));
    } catch (e) { console.log(chalk.red(`  ❌ ${e.message}`)); }
  }
  applyConfig(model, endpoint, endpointNoV1) {
    const cxDir = path.join(os.homedir(), '.codex');
    const cxConfig = path.join(cxDir, 'config.toml');
    const cxAuth = path.join(cxDir, 'auth.json');
    try {
      if (!fs.existsSync(cxDir)) fs.mkdirSync(cxDir, { recursive: true });
      let tomlContent = fs.existsSync(cxConfig) ? fs.readFileSync(cxConfig, 'utf8') : '';
      
      if (tomlContent.match(/model_provider\s*=/)) tomlContent = tomlContent.replace(/model_provider\s*=\s*".*"/, `model_provider = "voidRoute"`);
      else tomlContent = `model_provider = "voidRoute"\n` + tomlContent;
      
      if (tomlContent.match(/^model\s*=/m)) tomlContent = tomlContent.replace(/^model\s*=\s*".*"/m, `model = "${model}"`);
      else tomlContent = `model = "${model}"\n` + tomlContent;

      if (!tomlContent.includes('[model_providers.voidRoute]')) {
        tomlContent += `\n[model_providers.voidRoute]\nname = "voidRoute"\nbase_url = "${endpoint}"\nwire_api = "responses"\n`;
      }
      fs.writeFileSync(cxConfig, tomlContent.trim() + '\n');
      let authData = {};
      if (fs.existsSync(cxAuth)) { try { authData = JSON.parse(fs.readFileSync(cxAuth, 'utf8')); } catch (e) {} }
      authData.OPENAI_API_KEY = "sk_voidRoute"; authData.auth_mode = "apikey";
      fs.writeFileSync(cxAuth, JSON.stringify(authData, null, 2));
      console.log(chalk.green(`  ✅ Successfully updated ${cxConfig}`));
      console.log(chalk.yellow(`  ⚠️  Note: The Codex app only supports a single custom model at a time.`));
      console.log(chalk.yellow(`      It will display as "Custom Model" in the app UI, but will route correctly.`));
    } catch (e) { console.log(chalk.red(`  ❌ Failed to write config: ${e.message}`)); }
  }
}
