import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';

export class ClaudeAdapter extends BaseAdapter {
  constructor(isOpenClaude = false) {
    super(isOpenClaude ? 'openclaude' : 'claude', isOpenClaude ? 'OpenClaude' : 'Claude Code');
    this.isOpenClaude = isOpenClaude;
  }
  resolveConfigPath() {
    const home = os.homedir();
    return [
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.openclaude', 'settings.json'),
    ];
  }
  detectStatus() {
    try {
      const paths = this.resolveConfigPath();
      const found = paths.find(p => fs.existsSync(p));
      if (!found) return null;
      const s = JSON.parse(fs.readFileSync(found, 'utf8'));
      return s?.env?.ANTHROPIC_BASE_URL?.includes('localhost') ? 'connected' : null;
    } catch (e) { return null; }
  }
  resetConfig() {
    try {
      for (const p of this.resolveConfigPath()) {
        if (fs.existsSync(p)) {
          let s = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (s.env) {
            delete s.env.ANTHROPIC_BASE_URL;
            delete s.env.ANTHROPIC_AUTH_TOKEN;
            delete s.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
            delete s.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
            delete s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
            delete s.env.ANTHROPIC_MODEL;
            delete s.env.API_TIMEOUT_MS;
            if (this.isOpenClaude) {
              delete s.env.OPENAI_API_KEY;
              delete s.env.OPENAI_BASE_URL;
              delete s.env.OPENAI_MODEL;
              delete s.env.CLAUDE_CODE_USE_OPENAI;
            }
            if (Object.keys(s.env).length === 0) delete s.env;
          }
          fs.writeFileSync(p, JSON.stringify(s, null, 2));
        }
      }
      console.log(chalk.green(`  ✅ voidRoute config removed from ${this.displayName}.`));
    } catch (e) { console.log(chalk.red(`  ❌ ${e.message}`)); }
  }
  applyConfig(model, endpoint, endpointNoV1) {
    const configPath = this.getConfigPath();
    const configDir = path.dirname(configPath);
    const allConfPaths = this.resolveConfigPath().join('\n     or ');
    const hasProviderPrefix = model.includes('/');
    
    let currentSettings = {};
    const existingPath = this.resolveConfigPath().find(p => fs.existsSync(p));
    const writePath = existingPath || configPath;
    try { if (fs.existsSync(writePath)) currentSettings = JSON.parse(fs.readFileSync(writePath, 'utf8')); } catch (e) { }
    currentSettings.hasCompletedOnboarding = true;
    if (!currentSettings.env) currentSettings.env = {};
    
    if (this.isOpenClaude && hasProviderPrefix) {
      currentSettings.env.CLAUDE_CODE_USE_OPENAI = '1';
      currentSettings.env.OPENAI_BASE_URL = endpoint;
      currentSettings.env.OPENAI_MODEL = model;
      currentSettings.env.OPENAI_API_KEY = 'sk_voidRoute';
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(writePath, JSON.stringify(currentSettings, null, 2));
      console.log(chalk.green(`  ✅ ${this.displayName} configured via OpenAI-compatible mode`));
      console.log(chalk.gray(`     Config: ${writePath}`));
      console.log(chalk.gray(`     Model: ${model}`));
      console.log(chalk.dim(`     (Other possible paths: ${allConfPaths})`));
    } else {
      currentSettings.env.ANTHROPIC_BASE_URL = endpointNoV1;
      currentSettings.env.ANTHROPIC_AUTH_TOKEN = "sk_voidRoute";
      currentSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      currentSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      currentSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      currentSettings.env.ANTHROPIC_MODEL = model;
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(writePath, JSON.stringify(currentSettings, null, 2));
      console.log(chalk.green(`  ✅ ${this.displayName} configured via Anthropic API mode`));
      console.log(chalk.gray(`     Config: ${writePath}`));
      console.log(chalk.gray(`     Model: ${model}`));
      console.log(chalk.dim(`     (Other possible paths: ${allConfPaths})`));
      if (hasProviderPrefix && !this.isOpenClaude) {
        console.log(chalk.yellow(`  ⚠️  Note: Claude Code's Anthropic API mode may not support non-Anthropic models.`));
        console.log(chalk.yellow(`  ⚠️  Use OpenClaude instead for cross-provider model routing.`));
      }
    }
  }
}
