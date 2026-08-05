import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { BaseAdapter } from './BaseAdapter.js';

const HERMESS_PROVIDER_ID = 'voidroute';
const MAIN_MODEL_PROVIDER_VALUE = `custom:${HERMESS_PROVIDER_ID}`;

// ─── Minimal line-based YAML helpers (2-space indent, no external deps) ──────

function splitLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n');
}

function yamlScalar(value) {
  const s = String(value);
  if (s === '') return '""';
  // Single-quote anything non-trivial; escape embedded quotes by doubling.
  return `'${s.replace(/'/g, "''")}'`;
}

// Find range [start, end) of a top-level mapping key block. Lines before
// `start` and from `end` onward belong to other top-level keys or are comments.
function topLevelBlock(lines, key) {
  const keyRe = new RegExp(`^${key}:(\\s.*)?$`);
  const start = lines.findIndex((line) => keyRe.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) continue;
    if (line.trimStart().startsWith('#')) continue;
    end = i;
    break;
  }
  return { start, end };
}

// Smallest indent (leading spaces count) used by non-empty indented lines in a
// block, or fallback if the block is empty.
function childIndentOf(lines, block, fallback = '  ') {
  for (let i = block.start + 1; i < block.end; i++) {
    const match = lines[i].match(/^(\s+)\S/);
    if (match) return match[1];
  }
  return fallback;
}

// Remove a named sub-block (e.g. `voidroute:`) inside a block body.
function removeChildBlock(lines, block, childKey) {
  const childIndent = childIndentOf(lines, block);
  // Match the child key line at exactly childIndent.
  const headRe = new RegExp(`^${childIndent}${childKey}:(\\s.*)?$`);
  let cursor = block.start + 1;
  while (cursor < block.end) {
    if (!headRe.test(lines[cursor])) {
      cursor += 1;
      continue;
    }
    // Found head. Consume the head line plus its nested (deeper-indent) lines.
    let stop = cursor + 1;
    while (stop < block.end) {
      const line = lines[stop];
      if (line.trim() === '') break;
      if (line.startsWith(childIndent) && !line.startsWith(`${childIndent} `) && !line.startsWith(`${childIndent}\t`)) break;
      stop += 1;
    }
    lines.splice(cursor, stop - cursor);
    block.end -= stop - cursor;
    return true;
  }
  return false;
}

// Remove lines like `  default: ...` (direct children of a block at childIndent).
function removeChildKeys(lines, block, keys) {
  const childIndent = childIndentOf(lines, block);
  const keyRe = new RegExp(`^${childIndent}(${keys.map(escapeRegex).join('|')}):(\\s.*)?$`);
  for (let i = block.start + 1; i < block.end; i++) {
    if (keyRe.test(lines[i])) {
      lines.splice(i, 1);
      block.end -= 1;
      i -= 1;
    }
  }
}

function getChildKeyValue(lines, block, key) {
  const childIndent = childIndentOf(lines, block);
  const keyRe = new RegExp(`^${childIndent}${key}:\\s*(.*)$`);
  for (let i = block.start + 1; i < block.end; i++) {
    const match = lines[i].match(keyRe);
    if (match) return unquote(match[1].trim());
  }
  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquote(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"');
  return value;
}

// Insert lines inside a block, right after the head line.
function appendToBlock(lines, block, newLines) {
  lines.splice(block.start + 1, 0, ...newLines);
  block.end += newLines.length;
}

function ensureTopLevelBlock(lines, key) {
  let block = topLevelBlock(lines, key);
  if (block) return block;
  lines.push(`${key}:`);
  return { start: lines.length - 1, end: lines.length };
}

// Sanitize trailing blank lines left behind by removals.
function normalizeTrailing(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function buildProviderLines(baseIndent, { api, models }) {
  const indent = baseIndent.repeat(2);
  const entries = [
    `${baseIndent}${HERMESS_PROVIDER_ID}:`,
    `${indent}api: ${yamlScalar(api)}`,
  ];
  if (models && models.length > 0) {
    entries.push(`${indent}models:`);
    for (const model of models) entries.push(`${indent}- ${yamlScalar(model)}`);
  }
  return entries;
}

function buildModelLines(baseIndent, { defaultModel, provider }) {
  const indent = baseIndent.repeat(2);
  return [
    `${baseIndent}default: ${yamlScalar(defaultModel)}`,
    `${baseIndent}provider: ${yamlScalar(provider)}`,
  ];
}

/**
 * Merge the voidRoute-managed pieces into a Hermes config.yaml document.
 * Only touches: providers.voidroute block, and within the model block these
 * keys: default, provider, base_url (stale), api_key (stale). Everything else
 * is byte-preserved.
 *
 * @param {string} existingRaw existing config.yaml content (may be empty).
 * @param {{ endpoint: string, defaultModel: string, models: string[] }} options
 */
export function renderHermesConfig(existingRaw, { endpoint, defaultModel, models }) {
  const lines = (existingRaw && existingRaw.trim()) ? splitLines(existingRaw) : [];

  // 1. providers.voidroute — remove previous owned block, re-insert fresh.
  const providersBlock = ensureTopLevelBlock(lines, 'providers');
  removeChildBlock(lines, providersBlock, HERMESS_PROVIDER_ID);
  const providersIndent = childIndentOf(lines, providersBlock);
  appendToBlock(lines, providersBlock, buildProviderLines(providersIndent, { api: endpoint, models }));

  // 2. model block — remove our owned keys + stale custom-endpoint keys, re-add.
  const modelBlock = ensureTopLevelBlock(lines, 'model');
  removeChildKeys(lines, modelBlock, ['default', 'provider', 'base_url', 'api_key']);
  const modelIndent = childIndentOf(lines, modelBlock);
  appendToBlock(lines, modelBlock, buildModelLines(modelIndent, {
    defaultModel,
    provider: MAIN_MODEL_PROVIDER_VALUE,
  }));

  return `${normalizeTrailing(lines.join('\n'))}\n`;
}

/**
 * Remove voidRoute-owned config from a Hermes config.yaml document.
 * Strips providers.voidroute and, only if model.provider === 'custom:voidroute',
 * also removes model: default + provider. Bytes for everything else preserved.
 */
export function stripHermesConfig(existingRaw) {
  const lines = (existingRaw && existingRaw.trim()) ? splitLines(existingRaw) : [''];
  const providersBlock = topLevelBlock(lines, 'providers');
  if (providersBlock) removeChildBlock(lines, providersBlock, HERMESS_PROVIDER_ID);

  const modelBlock = topLevelBlock(lines, 'model');
  if (modelBlock) {
    const currentProvider = getChildKeyValue(lines, modelBlock, 'provider');
    if (currentProvider === MAIN_MODEL_PROVIDER_VALUE) {
      removeChildKeys(lines, modelBlock, ['default', 'provider', 'base_url', 'api_key']);
    }
  }

  return `${normalizeTrailing(lines.join('\n'))}\n`;
}

export class HermesAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('hermes', 'Hermes Agent');
    this.home = options.home || os.homedir();
    // When home is overridden (tests, portable installs), keep LOCALAPPDATA inside it
    // so detection never leaks into the real Hermes install.
    this.localAppData = options.localAppData || (options.home ? path.join(options.home, 'AppData', 'Local') : null) || process.env.LOCALAPPDATA || null;
  }

  // Hermes Desktop on Windows ignores ~/.hermes and reads its state from
  // %LOCALAPPDATA%\Hermes (we also patch the lowercase sibling that some builds
  // create). CLI installs still use ~/.hermes, so we always include it.
  configDirs() {
    const dirs = [];
    if (process.platform === 'win32' && this.localAppData) {
      dirs.push(path.join(this.localAppData, 'Hermes'));
      dirs.push(path.join(this.localAppData, 'hermes'));
    }
    dirs.push(path.join(this.home, '.hermes'));
    return Array.from(new Set(dirs));
  }

  configPaths() {
    return this.configDirs().map((dir) => path.join(dir, 'config.yaml'));
  }

  resolveConfigPath() {
    return this.configPaths();
  }

  existingConfigPaths() {
    return this.configPaths().filter((file) => fs.existsSync(file));
  }

  configPath() {
    const existing = this.existingConfigPaths();
    if (existing.length > 0) return existing[0];
    return this.configPaths()[0];
  }

  // Best-effort cache purge so Desktop re-fetches models after config change.
  clearModelCaches() {
    const removed = [];
    for (const dir of this.configDirs()) {
      for (const rel of ['provider_models_cache.json', path.join('cache', 'model_catalog.json')]) {
        const target = path.join(dir, rel);
        try {
          if (fs.existsSync(target)) {
            fs.unlinkSync(target);
            removed.push(target);
          }
        } catch { /* non-fatal */ }
      }
    }
    return removed;
  }

  detectStatus() {
    try {
      for (const file of this.configPaths()) {
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        const lines = splitLines(raw);
        const block = topLevelBlock(lines, 'providers');
        if (!block) continue;
        const childIndent = childIndentOf(lines, block);
        const headRe = new RegExp(`^${childIndent}${HERMESS_PROVIDER_ID}:(\\s.*)?$`);
        if (lines.slice(block.start, block.end).some((line) => headRe.test(line))) return 'connected';
      }
      return null;
    } catch {
      return null;
    }
  }

  applyConfig(model, endpoint, endpointNoV1, providerModelsList = [], allModelsForProvider = null, defaultModelForTool = null) {
    try {
      const modelIds = (Array.isArray(allModelsForProvider) && allModelsForProvider.length > 0)
        ? Array.from(new Set(allModelsForProvider.map((id) => String(id))))
        : Array.from(new Set(providerModelsList.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)));
      const defaultModel = String(defaultModelForTool || model || modelIds[0] || '');
      if (!defaultModel) throw new Error('Hermes apply requires a default model');

      for (const file of this.configPaths()) {
        try {
          // Keep user config intact: only patch paths where a config already
          // exists. When none exists, fall back to the primary path.
          if (!fs.existsSync(file) && file !== this.configPaths()[0]) continue;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
          fs.writeFileSync(file, renderHermesConfig(existing, {
            endpoint,
            defaultModel,
            models: modelIds.length > 0 ? modelIds : [defaultModel],
          }));
        } catch (err) {
          console.log(chalk.red(`  ❌ Failed to write ${file}: ${err.message}`));
        }
      }
      const purged = this.clearModelCaches();
      if (purged.length > 0) console.log(chalk.gray(`  🧹 Cleared model cache: ${purged.map((f) => path.basename(f)).join(', ')}`));

      console.log(chalk.green('  ✅ Hermes Agent configured with voidRoute.'));
      console.log(chalk.cyan(`  📦 Registered ${modelIds.length || 1} model(s) under providers.${HERMESS_PROVIDER_ID}.`));
      console.log(chalk.gray('  ℹ️  Restart Hermes if the new models do not appear immediately.'));
      console.log(chalk.gray('  ℹ️  In Hermes: switch with "/model custom:voidroute:<model>" later.'));
      return { applied: true, configPath: this.configPath(), models: modelIds, defaultModel };
    } catch (error) {
      console.log(chalk.red(`  ❌ Failed to write Hermes config: ${error.message}`));
      return { applied: false, error };
    }
  }

  resetConfig() {
    try {
      const existing = this.existingConfigPaths();
      if (existing.length === 0) {
        console.log(chalk.gray('  No Hermes config found.'));
        return { reset: false };
      }
      for (const file of existing) {
        try {
          const raw = fs.readFileSync(file, 'utf8');
          fs.copyFileSync(file, `${file}.bak`);
          fs.writeFileSync(file, stripHermesConfig(raw));
        } catch (err) {
          console.log(chalk.red(`  ❌ ${file}: ${err.message}`));
        }
      }
      this.clearModelCaches();
      console.log(chalk.green('  ✅ voidRoute config removed from Hermes Agent.'));
      return { reset: true };
    } catch (error) {
      console.log(chalk.red(`  ❌ ${error.message}`));
      return { reset: false, error };
    }
  }
}
