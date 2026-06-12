import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';

export class AiderAdapter extends BaseAdapter {
  constructor() { super('aider', 'Aider'); }
  resolveConfigPath() {
    const home = os.homedir();
    return [
      path.join(home, '.aider.conf.yml'),
      path.join(home, '.config', 'aider', 'aider.conf.yml'),
    ];
  }
  detectStatus() {
    try {
      const paths = this.resolveConfigPath();
      const found = paths.find(p => fs.existsSync(p));
      if (!found) return null;
      return fs.readFileSync(found, 'utf8').includes('localhost') ? 'connected' : null;
    } catch (e) { return null; }
  }
  resetConfig() {
    const aiderPath = path.join(os.homedir(), '.aider.conf.yml');
    try {
      if (fs.existsSync(aiderPath)) {
        let conf = fs.readFileSync(aiderPath, 'utf8');
        conf = conf.replace(/^openai-api-base:.*$/gm, '').replace(/^openai-api-key:.*$/gm, '').replace(/^model:.*$/gm, '');
        fs.writeFileSync(aiderPath, conf.replace(/\n{3,}/g, '\n\n').trim() + '\n');
        console.log(chalk.green(`  ✅ voidRoute config removed from Aider.`));
      } else {
        console.log(chalk.gray('  No config file found.'));
      }
    } catch (e) { console.log(chalk.red(`  ❌ ${e.message}`)); }
  }
  applyConfig(model, endpoint, endpointNoV1) {
    const aiderPath = path.join(os.homedir(), '.aider.conf.yml');
    try {
      let conf = fs.existsSync(aiderPath) ? fs.readFileSync(aiderPath, 'utf8') : '';
      conf = conf.replace(/^openai-api-base:.*$/gm, '').replace(/^openai-api-key:.*$/gm, '').replace(/^model:.*$/gm, '').trim();
      const yamlContent = `
openai-api-key: sk_voidRoute
openai-api-base: ${endpoint}
model: ${model}
`;
      fs.writeFileSync(aiderPath, conf.trim() + yamlContent + '\n');
      console.log(chalk.green(`  ✅ Successfully updated ${aiderPath}`));
    } catch (e) { console.log(chalk.red(`  ❌ Failed to write config: ${e.message}`)); }
  }
}
