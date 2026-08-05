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
      const content = fs.readFileSync(found, 'utf8');
      const hasVoidRouteProvider = content.includes('[model_providers.voidRoute]') || content.includes('model_provider = "voidRoute"');
      const hasVoidRouteOpenai = content.includes('openai_base_url') && content.includes('20130');
      return (hasVoidRouteProvider || hasVoidRouteOpenai) ? 'connected' : null;
    } catch (e) { return null; }
  }
  resetConfig() {
    const cxDir = path.join(os.homedir(), '.codex');
    const cxConfig = path.join(cxDir, 'config.toml');
    const cxAuth = path.join(cxDir, 'auth.json');
    const cxCache = path.join(cxDir, 'models_cache.json');
    try {
      if (fs.existsSync(cxConfig)) {
        let toml = fs.readFileSync(cxConfig, 'utf8');
        toml = toml.replace(/#.*voidRoute.*$/gm, '');
        toml = toml.replace(/^openai_base_url\s*=.*$/gm, '');
        toml = toml.replace(/^model_provider\s*=.*$/gm, 'model_provider = "anthropic"');
        toml = toml.replace(/^model_catalog_json\s*=.*$/gm, '');
        toml = toml.replace(/^model\s*=.*$/gm, 'model = "claude-3-5-sonnet"');
        toml = toml.replace(/\[model_providers\.voidRoute\][\s\S]*?(?=\n\[|$)/g, '');
        fs.writeFileSync(cxConfig, toml.replace(/\n{3,}/g, '\n\n').trim() + '\n');
      }
      if (fs.existsSync(cxCache)) {
        let cache = JSON.parse(fs.readFileSync(cxCache, 'utf8'));
        if (cache._voidRoute_backup) {
          cache.data = cache._voidRoute_backup.data || [];
          cache.models = cache._voidRoute_backup.models || [];
          delete cache._voidRoute_backup;
        }
        if (Array.isArray(cache.data)) {
          cache.data = cache.data.filter(d => d.owned_by !== 'voidRoute');
        }
        if (Array.isArray(cache.models)) {
          cache.models = cache.models.filter(m => m.provider_id !== 'voidRoute');
        }
        fs.writeFileSync(cxCache, JSON.stringify(cache, null, 2));
      }
      if (fs.existsSync(cxAuth)) {
        let auth = JSON.parse(fs.readFileSync(cxAuth, 'utf8'));
        if (auth.OPENAI_API_KEY === 'sk_voidRoute') {
          delete auth.OPENAI_API_KEY;
        }
        if (auth.auth_mode === 'apikey') {
          delete auth.auth_mode;
        }
        fs.writeFileSync(cxAuth, JSON.stringify(auth, null, 2));
      }
      console.log(chalk.green(`  ✅ voidRoute config removed from Codex.`));
    } catch (e) { console.log(chalk.red(`  ❌ ${e.message}`)); }
  }
  applyConfig(model, endpoint, endpointNoV1, providerModelsList = [], allModelsForProvider = null, defaultModelForTool = null) {
    const cxDir = path.join(os.homedir(), '.codex');
    const cxConfig = path.join(cxDir, 'config.toml');
    const cxAuth = path.join(cxDir, 'auth.json');
    const cxCache = path.join(cxDir, 'models_cache.json');
    try {
      if (!fs.existsSync(cxDir)) fs.mkdirSync(cxDir, { recursive: true });
      let tomlContent = fs.existsSync(cxConfig) ? fs.readFileSync(cxConfig, 'utf8') : '';

      tomlContent = tomlContent.replace(/^openai_base_url\s*=.*$/gm, '');
      tomlContent = tomlContent.replace(/^model_provider\s*=.*$/gm, '');
      tomlContent = tomlContent.replace(/^model_catalog_json\s*=.*$/gm, '');
      tomlContent = tomlContent.replace(/^model\s*=.*$/gm, '');
      tomlContent = tomlContent.replace(/\[model_providers\.voidRoute\][\s\S]*?(?=\n\[|$)/g, '');
      tomlContent = tomlContent.replace(/\n{3,}/g, '\n\n').trim();

      const selectedModel = defaultModelForTool || model;
      const catalogPath = cxCache.replace(/\\/g, '/');

      const topKeys = [
        `# voidRoute proxy (OpenCodex multi-model configuration)`,
        `openai_base_url = "${endpoint}"`,
        `model_provider = "openai"`,
        `model = "${selectedModel}"`,
        `model_catalog_json = "${catalogPath}"`
      ].join('\n');

      const firstTableIdx = tomlContent.search(/^\[/m);
      if (firstTableIdx !== -1) {
        const before = tomlContent.slice(0, firstTableIdx).trim();
        const after = tomlContent.slice(firstTableIdx).trim();
        tomlContent = (before ? before + '\n\n' : '') + topKeys + '\n\n' + after;
      } else {
        tomlContent = (tomlContent ? tomlContent + '\n\n' : '') + topKeys;
      }
      tomlContent = tomlContent.trim() + '\n';
      fs.writeFileSync(cxConfig, tomlContent);

      let authData = {};
      if (fs.existsSync(cxAuth)) { try { authData = JSON.parse(fs.readFileSync(cxAuth, 'utf8')); } catch (e) {} }
      authData.auth_mode = "apikey";
      authData.OPENAI_API_KEY = "sk_voidRoute";
      fs.writeFileSync(cxAuth, JSON.stringify(authData, null, 2));

      const modelIds = (allModelsForProvider && allModelsForProvider.length > 0)
        ? allModelsForProvider
        : (providerModelsList.length > 0 ? providerModelsList.map(m => m.id) : [model]);

      this.writeModelsCache(modelIds);

      console.log(chalk.green(`  ✅ Codex configured with OpenCodex multi-model routing via voidRoute.`));
      if (modelIds.length > 1) {
        console.log(chalk.cyan(`  📦 Registered ${modelIds.length} models in Codex models_cache.json.`));
      }
      console.log(chalk.cyan(`  ℹ️  Restart Codex (close and reopen) then select models from the model picker.`));
    } catch (e) { console.log(chalk.red(`  ❌ Failed to write config: ${e.message}`)); }
  }

  writeModelsCache(allModelIds) {
    const cxDir = path.join(os.homedir(), '.codex');
    const cachePath = path.join(cxDir, 'models_cache.json');
    try {
      if (!fs.existsSync(cxDir)) fs.mkdirSync(cxDir, { recursive: true });
      let existing = { data: [], models: [] };
      if (fs.existsSync(cachePath)) {
        try { existing = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) {}
      }
      const now = Math.floor(Date.now() / 1000);
      const newData = [];
      const newModels = [];
      for (const id of allModelIds) {
        const parts = id.split('/');
        const providerAlias = parts.length > 1 ? parts[0] : 'voidRoute';
        const modelSlug = parts.length > 1 ? parts.slice(1).join('/') : id;
        const displayName = `${providerAlias}/${modelSlug}`;
        newData.push({ id, object: 'model', created: now, owned_by: 'voidRoute' });
        newModels.push({
          slug: id,
          display_name: displayName,
          description: `Routed via voidRoute (${providerAlias})`,
          provider_id: 'openai',
          wire_api: 'responses',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Low reasoning' },
            { effort: 'medium', description: 'Medium reasoning' },
            { effort: 'high', description: 'High reasoning' }
          ],
          shell_type: 'shell_command',
          visibility: 'list',
          supported_in_api: true,
          priority: 99,
          context_window: 200000,
          max_context_window: 200000,
          input_modalities: ['text', 'image'],
          supports_parallel_tool_calls: true,
          use_responses_lite: true
        });
      }
      if (!existing._voidRoute_backup) {
        existing._voidRoute_backup = { data: [...(existing.data || [])], models: [...(existing.models || [])] };
      }
      const mergedData = [...(existing.data || [])];
      const mergedModels = [...(existing.models || [])];
      for (const d of newData) {
        if (!mergedData.find(x => x.id === d.id)) mergedData.push(d);
      }
      for (const m of newModels) {
        if (!mergedModels.find(x => x.slug === m.slug)) mergedModels.push(m);
      }
      existing.data = mergedData;
      existing.models = mergedModels;
      existing.fetched_at = new Date().toISOString();
      fs.writeFileSync(cachePath, JSON.stringify(existing, null, 2));
    } catch (e) { console.log(chalk.gray(`  (models_cache: ${e.message})`)); }
  }
}