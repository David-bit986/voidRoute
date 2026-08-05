import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodexLifecycle } from './CodexLifecycle.js';
import { formatModelReference, parseModelReference } from '#shared/constants/modelIdentity.js';

export const CATALOG_FILENAME = 'voidRoute-catalog.json';
export const BACKUP_FILENAME = 'voidRoute-backup.json';
export const MODELS_CACHE_FILENAME = 'models_cache.json';
export const MODELS_CACHE_BACKUP_FILENAME = 'voidRoute-models-cache-backup.json';
export const STATE_FILENAME = '.voidRoute-codex-state.json';
export const RECOVERY_DIRECTORY = '.voidRoute-codex-recovery';
export const LOCK_FILENAME = '.voidRoute-codex.lock';
export const RECOVERY_STATE_FILENAME = 'state.previous';
export const LIFECYCLE_MARKER = 'voidRoute.codex.lifecycle.v1';

export const RECOVERY_BACKUP_NAMES = Object.freeze({
  original: Object.freeze({
    config: 'config.backup',
    auth: 'auth.backup',
    catalog: 'catalog.backup',
    modelsCache: 'models-cache.backup',
  }),
  previous: Object.freeze({
    config: 'config.previous',
    auth: 'auth.previous',
    catalog: 'catalog.previous',
    modelsCache: 'models-cache.previous',
  }),
});

const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const EFFORT_MAP = { max: 'xhigh', ultra: 'xhigh', high_max: 'xhigh' };
const ROUTED_NATIVE_ONLY_FIELDS = [
  'model_messages',
  'tool_mode',
  'multi_agent_version',
  'use_responses_lite',
  'supports_websockets',
  'prefer_websockets',
  'websocket_transport',
  'websocket_path',
  'additional_speed_tiers',
  'service_tier',
  'service_tiers',
  'default_service_tier',
];

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value)) output[key] = deepClone(value[key]);
    return output;
  }
  return value;
}

function readJson(file, fileSystem = fs) {
  if (!fileSystem.existsSync(file)) return null;
  try {
    return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isSymlink(file, fileSystem = fs) {
  try {
    return fileSystem.lstatSync(file).isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertNoSymlinkInPath(file, fileSystem = fs) {
  let current = path.resolve(file);
  while (true) {
    if (isSymlink(current, fileSystem)) {
      throw new Error(`Refusing to manage symlink path: ${file}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertRealPathWithin(home, file, fileSystem = fs) {
  const realpath = fileSystem.realpathSync?.native || fileSystem.realpathSync;
  if (typeof realpath !== 'function' || !fileSystem.existsSync(home)) return;
  let realHome;
  try {
    realHome = realpath(home);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  let existing = path.resolve(file);
  while (true) {
    try {
      fileSystem.lstatSync(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return;
      existing = parent;
    }
  }
  const resolved = realpath(existing);
  const relative = path.relative(realHome, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Managed Codex path resolves outside CODEX_HOME: ${file}`);
  }
}

export function getCodexHome() {
  const configured = process.env.CODEX_HOME;
  const home = path.resolve(configured || path.join(os.homedir(), '.codex'));
  if (home.includes('\0')) throw new Error('CODEX_HOME contains a NUL byte');
  return home;
}

export function validateCodexHome(fileSystem = fs, { create = false } = {}) {
  const home = getCodexHome();
  assertNoSymlinkInPath(home, fileSystem);
  if (create && !fileSystem.existsSync(home)) {
    fileSystem.mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  if (!fileSystem.existsSync(home)) return home;
  assertNoSymlinkInPath(home, fileSystem);
  const stat = fileSystem.lstatSync(home);
  if (!stat.isDirectory()) throw new Error(`CODEX_HOME is not a directory: ${home}`);
  return home;
}

export function validateManagedPath(file, fileSystem = fs) {
  const home = validateCodexHome(fileSystem);
  const absolute = path.resolve(file);
  if (absolute.includes('\0')) throw new Error('Managed Codex path contains a NUL byte');
  const relative = path.relative(home, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Managed Codex path escapes CODEX_HOME: ${file}`);
  }
  assertNoSymlinkInPath(absolute, fileSystem);
  assertRealPathWithin(home, absolute, fileSystem);
  return absolute;
}

function validateGenerationName(generation) {
  if (typeof generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation)) {
    throw new Error('Codex recovery generation is invalid');
  }
  return generation;
}

export function validateRecoveryRoot(fileSystem = fs) {
  const home = validateCodexHome(fileSystem);
  const root = path.resolve(getRecoveryDirectory());
  if (path.dirname(root) !== home || path.basename(root) !== RECOVERY_DIRECTORY) {
    throw new Error(`Codex recovery root is not directly under CODEX_HOME: ${root}`);
  }
  validateManagedPath(root, fileSystem);
  if (fileSystem.existsSync(root) && !fileSystem.lstatSync(root).isDirectory()) {
    throw new Error(`Codex recovery root is not a directory: ${root}`);
  }
  return root;
}

export function validateRecoveryGeneration(directory, fileSystem = fs, generation = null) {
  const root = validateRecoveryRoot(fileSystem);
  const absolute = path.resolve(directory);
  const relative = path.relative(root, absolute);
  if (!relative || relative.includes(path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Codex recovery generation is outside the fixed recovery root: ${directory}`);
  }
  const name = validateGenerationName(generation || relative);
  if (name !== relative) throw new Error('Codex recovery generation does not match its directory');
  validateManagedPath(absolute, fileSystem);
  if (fileSystem.existsSync(absolute) && !fileSystem.lstatSync(absolute).isDirectory()) {
    throw new Error(`Codex recovery generation is not a directory: ${absolute}`);
  }
  return absolute;
}

export function recoveryBackupName(kind, key) {
  const name = RECOVERY_BACKUP_NAMES[kind]?.[key];
  if (!name) throw new Error(`Unknown Codex recovery backup: ${kind}/${key}`);
  return name;
}

export function getCatalogPath() {
  return path.join(getCodexHome(), CATALOG_FILENAME);
}

export function getBackupPath() {
  return path.join(getCodexHome(), BACKUP_FILENAME);
}

export function getModelsCachePath() {
  return path.join(getCodexHome(), MODELS_CACHE_FILENAME);
}

export function getModelsCacheBackupPath() {
  return path.join(getCodexHome(), MODELS_CACHE_BACKUP_FILENAME);
}

export function getStatePath() {
  return path.join(getCodexHome(), STATE_FILENAME);
}

export function getRecoveryDirectory() {
  return path.join(getCodexHome(), RECOVERY_DIRECTORY);
}

export function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomSuffix() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

// Use a same-directory temporary file so a successful rename is atomic on the
// platforms where Codex is supported. The fallback keeps replacement safe on
// Windows versions that reject rename-over-existing-file.
export function atomicWriteFile(file, data, { fileSystem = fs, mode = 0o600 } = {}) {
  const target = validateManagedPath(file, fileSystem);
  const directory = path.dirname(target);
  if (!fileSystem.existsSync(directory)) {
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const temporary = `${target}.tmp-${randomSuffix()}`;
  validateManagedPath(temporary, fileSystem);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  try {
    fileSystem.writeFileSync(temporary, bytes, { flag: 'wx', mode });
    try { fileSystem.chmodSync(temporary, mode); } catch { /* best effort on Windows */ }
    try {
      const descriptor = fileSystem.openSync(temporary, 'r');
      try {
        try { fileSystem.fsyncSync(descriptor); } catch (error) {
          if (!['EPERM', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
        }
      } finally { fileSystem.closeSync(descriptor); }
    } catch (error) {
      if (!['EPERM', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
    }
    try {
      fileSystem.renameSync(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code) || !fileSystem.existsSync(target)) {
        throw error;
      }
      // Windows may not rename over an open destination. Lifecycle callers
      // journal the existing bytes before this fallback, so unlinking avoids
      // leaving credential-bearing .old-* files behind after a crash.
      validateManagedPath(target, fileSystem);
      fileSystem.unlinkSync(target);
      try {
        fileSystem.renameSync(temporary, target);
      } catch (replaceError) {
        throw replaceError;
      }
    }
  } finally {
    try {
      if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary);
    } catch { /* the original error is more useful to the caller */ }
  }
}

export function removeManagedFile(file, fileSystem = fs) {
  const target = validateManagedPath(file, fileSystem);
  if (fileSystem.existsSync(target)) fileSystem.unlinkSync(target);
}

export function removeDirectory(directory, fileSystem = fs) {
  const target = validateManagedPath(directory, fileSystem);
  const home = validateCodexHome(fileSystem);
  const recoveryRoot = validateRecoveryRoot(fileSystem);
  if (target === home || path.dirname(target) !== recoveryRoot) {
    throw new Error(`Refusing to remove arbitrary Codex directory: ${directory}`);
  }
  if (!fileSystem.existsSync(target)) return;
  if (isSymlink(target, fileSystem)) throw new Error(`Refusing to remove symlink path: ${target}`);
  for (const entry of fileSystem.readdirSync(target)) {
    const child = path.join(target, entry);
    const stat = fileSystem.lstatSync(child);
    if (!stat.isFile()) throw new Error(`Refusing to remove unknown Codex recovery artifact: ${child}`);
    fileSystem.unlinkSync(child);
  }
  fileSystem.rmdirSync(target);
}

function modelEntries(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.models) ? value.models : [];
}

export function isNativeCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.slug !== 'string' || !entry.slug) return false;
  if (entry.slug.includes('\0')) return false;
  const reference = parseModelReference(entry.slug);
  return reference.providerAlias === null && (!entry.provider_id || entry.provider_id === 'openai');
}

/**
 * Remap routed model ids whose provider prefix is a custom node id to the
 * node's short prefix (e.g. `openai-compatible-b-ai-6b121aac/minimax-m3` ->
 * `B.ai/minimax-m3`). `nodePrefixById` maps node id -> short prefix; ids whose
 * provider part is unknown are left untouched.
 */
export function remapRoutedNodePrefixes(modelIds, nodePrefixById = null) {
  if (!nodePrefixById) return modelIds;
  return modelIds.map((id) => {
    const value = String(id);
    const slash = value.indexOf('/');
    if (slash === -1) return value;
    const providerPart = value.slice(0, slash);
    const prefix = nodePrefixById[providerPart];
    if (!prefix) return value;
    return `${prefix}/${value.slice(slash + 1)}`;
  });
}

function uniqueNativeEntries(sources) {
  const seen = new Set();
  const entries = [];
  for (const source of sources) {
    for (const entry of modelEntries(source)) {
      if (!isNativeCatalogEntry(entry) || seen.has(entry.slug)) continue;
      seen.add(entry.slug);
      entries.push(deepClone(entry));
    }
  }
  return entries;
}

function readManagedJson(file, fileSystem) {
  try {
    validateManagedPath(file, fileSystem);
  } catch {
    return null;
  }
  return readJson(file, fileSystem);
}

function recoveryModelsCacheBackups(fileSystem = fs) {
  const sources = [];
  let root;
  try {
    root = validateRecoveryRoot(fileSystem);
  } catch {
    return sources;
  }
  if (!fileSystem.existsSync(root)) return sources;
  let generations;
  try {
    generations = fileSystem.readdirSync(root);
  } catch {
    return sources;
  }
  for (const generation of generations) {
    const directory = path.join(root, generation);
    try {
      if (!fileSystem.lstatSync(directory).isDirectory()) continue;
      validateRecoveryGeneration(directory, fileSystem, generation);
    } catch {
      continue;
    }
    const backupName = recoveryBackupName('original', 'modelsCache');
    const previousName = recoveryBackupName('previous', 'modelsCache');
    for (const name of [backupName, previousName]) {
      const file = path.join(directory, name);
      const data = readManagedJson(file, fileSystem);
      if (data) sources.push(data);
    }
  }
  return sources;
}

export function findNativeEntries(fileSystem = fs, existingCatalog = null) {
  const home = getCodexHome();
  const sources = [];

  // Prefer real native objects from multiple sources. Order matters for first-seen slug wins.
  if (existingCatalog !== null && existingCatalog !== undefined) {
    sources.push(existingCatalog);
  } else {
    sources.push(readManagedJson(getCatalogPath(), fileSystem));
  }

  sources.push(readManagedJson(path.join(home, 'models.json'), fileSystem));
  sources.push(readManagedJson(getModelsCachePath(), fileSystem));
  sources.push(readManagedJson(path.join(home, 'opencodex-catalog.json'), fileSystem));
  sources.push(...recoveryModelsCacheBackups(fileSystem));

  return uniqueNativeEntries(sources);
}

export function findNativeTemplate(fileSystem = fs, existingCatalog = null) {
  return findNativeEntries(fileSystem, existingCatalog)[0] || null;
}

export const DEFAULT_TEMPLATE = {
  display_name: '',
  description: '',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  ],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 99,
  availability_nux: null,
  upgrade: null,
  base_instructions: 'You are Codex, an autonomous coding agent. Collaborate with the user to complete their goal using the available tools.',
  include_skills_usage_instructions: false,
  default_reasoning_summary: 'none',
  support_verbosity: true,
  default_verbosity: 'low',
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text_and_image',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: false,
  supports_image_detail_original: true,
  context_window: 200000,
  max_context_window: 200000,
  comp_hash: 'voidRoute',
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ['text', 'image'],
  supports_search_tool: true,
  supports_reasoning_summaries: false,
  provider_id: 'openai',
  wire_api: 'responses',
};

function sanitizeEffort(effort) {
  const value = String(effort ?? 'medium');
  if (VALID_EFFORTS.includes(value)) return value;
  return EFFORT_MAP[value] || 'medium';
}

function normalizeInputModalities(value) {
  const input = Array.isArray(value) ? value : [];
  const accepted = input.filter((modality) => modality === 'text' || modality === 'image');
  return accepted.includes('text') ? [...new Set(accepted)] : ['text'];
}

function normalizeReasoningLevels(value) {
  const levels = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];
  for (const level of levels) {
    if (!level || typeof level !== 'object') continue;
    const effort = sanitizeEffort(level.effort);
    if (seen.has(effort)) continue;
    seen.add(effort);
    normalized.push({ effort, description: typeof level.description === 'string' ? level.description : '' });
  }
  if (normalized.length === 0) {
    normalized.push({ effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' });
  }
  return normalized;
}

function normalizeReasoningMetadata(entry) {
  entry.supported_reasoning_levels = normalizeReasoningLevels(entry.supported_reasoning_levels);
  entry.default_reasoning_level = sanitizeEffort(entry.default_reasoning_level);
  if (!entry.supported_reasoning_levels.some((level) => level.effort === entry.default_reasoning_level)) {
    entry.default_reasoning_level = entry.supported_reasoning_levels[0].effort;
  }
  return entry;
}

export function normalizeRoutedCatalogEntry(entry) {
  for (const field of ROUTED_NATIVE_ONLY_FIELDS) delete entry[field];
  delete entry.availability_nux;
  entry.visibility = 'list';
  entry.upgrade = null;
  entry.web_search_tool_type = 'text_and_image';
  entry.supports_search_tool = true;
  entry.supports_parallel_tool_calls = false;
  entry.supports_reasoning_summaries = false;
  entry.input_modalities = normalizeInputModalities(entry.input_modalities);
  normalizeReasoningMetadata(entry);
  return entry;
}

function ensureRequiredString(entry, field) {
  if (typeof entry[field] !== 'string' || entry[field].length === 0) {
    throw new Error(`Codex catalog entry is missing required string field: ${field}`);
  }
}

export function validateCatalogEntry(entry) {
  for (const field of ['slug', 'display_name', 'description', 'base_instructions', 'provider_id', 'wire_api']) {
    ensureRequiredString(entry, field);
  }
  if (entry.visibility !== 'list') throw new Error('Codex catalog visibility must be list');
  if (!Array.isArray(entry.input_modalities) || entry.input_modalities.length === 0
      || entry.input_modalities.some((modality) => !['text', 'image'].includes(modality))) {
    throw new Error(`Invalid input modalities for Codex model ${entry.slug}`);
  }
  if (!Array.isArray(entry.supported_reasoning_levels) || entry.supported_reasoning_levels.length === 0) {
    throw new Error(`Missing reasoning levels for Codex model ${entry.slug}`);
  }
  const efforts = new Set(entry.supported_reasoning_levels.map((level) => level.effort));
  if (entry.supported_reasoning_levels.some((level) => !VALID_EFFORTS.includes(level.effort))
      || !efforts.has(entry.default_reasoning_level)) {
    throw new Error(`Invalid reasoning levels for Codex model ${entry.slug}`);
  }
  if (!(entry.context_window > 0) || !(entry.max_context_window > 0)) {
    throw new Error(`Invalid context window for Codex model ${entry.slug}`);
  }
  return entry;
}

export function buildCatalog(modelIds, template = null, options = {}) {
  if (!Array.isArray(modelIds)) throw new Error('Codex catalog model IDs must be an array');
  const fileSystem = options.fileSystem || fs;
  const discoveredNativeEntries = Array.isArray(options.nativeEntries)
    ? options.nativeEntries
    : findNativeEntries(fileSystem, options.existingCatalog);
  const explicitNativeEntries = Array.isArray(template) ? template : (template ? [template] : []);
  const nativeEntries = uniqueNativeEntries([discoveredNativeEntries, explicitNativeEntries]);
  // Prefer a real native entry as the routed template when available; never treat routed-only cache as natives.
  const source = nativeEntries[0] || DEFAULT_TEMPLATE;
  const models = [];
  const seen = new Set();
  for (const nativeEntry of nativeEntries) {
    const entry = deepClone(nativeEntry);
    if (typeof entry.display_name !== 'string' || entry.display_name.length === 0) {
      entry.display_name = entry.slug;
    }
    // The installed Codex parser rejects native catalog entries that advertise
    // newer effort variants such as max/ultra. Keep the native metadata, but
    // emit the parser's supported enum for every catalog entry.
    normalizeReasoningMetadata(entry);
    seen.add(entry.slug);
    models.push(entry);
  }

  const selectedProvider = modelIds
    .map((raw) => parseModelReference(String(raw ?? '')).provider)
    .find((provider) => provider !== null);

  for (const raw of modelIds) {
    const id = String(raw ?? '');
    if (!id || id.includes('\0')) throw new Error('Codex model IDs must be non-empty strings without NUL bytes');
    const reference = parseModelReference(id);
    if (selectedProvider !== null && reference.provider !== null && reference.provider !== selectedProvider) continue;
    const slug = formatModelReference(reference, { preserveInputAlias: true });
    if (seen.has(slug)) continue;
    seen.add(slug);
    const entry = deepClone(source);
    entry.slug = slug;
    entry.display_name = id;
    entry.description = `Routed via voidRoute`;
    entry.provider_id = 'openai';
    entry.wire_api = 'responses';
    entry.visibility = 'list';
    if (typeof entry.priority !== 'number') entry.priority = 99;
    else entry.priority = Math.max(entry.priority, 99);
    if (!(entry.context_window > 0)) entry.context_window = 200000;
    if (!(entry.max_context_window > 0)) entry.max_context_window = entry.context_window;
    entry.input_modalities = normalizeInputModalities(entry.input_modalities);
    normalizeRoutedCatalogEntry(entry);
    validateCatalogEntry(entry);
    models.push(entry);
  }
  if (models.length === 0) throw new Error('Codex catalog requires at least one unique model');
  return { fetched_at: new Date().toISOString(), etag: '', client_version: '', models };
}

export function writeCatalog(modelIds, template = null, options = {}) {
  const home = validateCodexHome(options.fileSystem || fs, { create: true });
  const catalogPath = validateManagedPath(path.join(home, CATALOG_FILENAME), options.fileSystem || fs);
  const data = JSON.stringify(buildCatalog(modelIds, template, options), null, 2) + '\n';
  atomicWriteFile(catalogPath, data, options);
  return catalogPath;
}

export function removeCatalog(fileSystem = fs) {
  removeManagedFile(getCatalogPath(), fileSystem);
}

// These legacy helpers remain exported for callers outside the lifecycle. The
// lifecycle itself refuses to trust these fixed-name backups.
export function readBackup(fileSystem = fs) {
  validateManagedPath(getBackupPath(), fileSystem);
  return readJson(getBackupPath(), fileSystem);
}

export function writeBackup(value, options = {}) {
  validateCodexHome(options.fileSystem || fs, { create: true });
  validateManagedPath(getBackupPath(), options.fileSystem || fs);
  atomicWriteFile(getBackupPath(), JSON.stringify(value, null, 2) + '\n', options);
}

export function removeBackup(fileSystem = fs) {
  validateManagedPath(getBackupPath(), fileSystem);
  removeManagedFile(getBackupPath(), fileSystem);
}

export function dedupeRootKeys(toml) {
  const lines = String(toml).split('\n');
  const firstTable = lines.findIndex((line) => parseTableHeader(line));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const rootLines = lines.slice(0, rootEnd);
  const rest = lines.slice(rootEnd);
  const lastIndex = new Map();
  const assignments = [];
  for (let index = 0; index < rootLines.length;) {
    const match = rootLines[index].match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/);
    if (!match) {
      index += 1;
      continue;
    }
    const end = findValueEnd(rootLines, index);
    assignments.push({ key: match[1], start: index, end });
    lastIndex.set(match[1], assignments.length - 1);
    index = end + 1;
  }
  const keep = new Set(lastIndex.values());
  const removed = new Set();
  assignments.forEach((assignment, index) => {
    if (!keep.has(index)) {
      for (let line = assignment.start; line <= assignment.end; line += 1) removed.add(line);
    }
  });
  return [...rootLines.filter((_, index) => !removed.has(index)), ...rest].join('\n').replace(/\n{3,}/g, '\n\n');
}

function parseTableHeader(line) {
  const match = String(line).match(/^\s*(\[\[?)([^\]]+)(\]\]?)(?:\s*#.*)?$/);
  if (!match || match[1].length !== match[3].length) return null;
  return { name: match[2].trim() };
}

function findValueEnd(lines, start) {
  let state = 'none';
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let lineIndex = start; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const valueStart = lineIndex === start ? line.indexOf('=') + 1 : 0;
    for (let index = valueStart; index < line.length; index += 1) {
      const character = line[index];
      const next = line[index + 1];
      const nextNext = line[index + 2];
      if (state === 'basic-multi' || state === 'literal-multi') {
        const terminator = state === 'basic-multi' ? '"' : "'";
        if (character === terminator && next === terminator && nextNext === terminator) {
          state = 'none';
          index += 2;
        }
        continue;
      }
      if (state === 'basic' || state === 'literal') {
        if (state === 'basic' && escaped) {
          escaped = false;
          continue;
        }
        if (state === 'basic' && character === '\\') {
          escaped = true;
          continue;
        }
        if ((state === 'basic' && character === '"') || (state === 'literal' && character === "'")) {
          state = 'none';
        }
        continue;
      }
      if (character === '#') break;
      if (character === '"' && next === '"' && nextNext === '"') {
        state = 'basic-multi';
        index += 2;
      } else if (character === "'" && next === "'" && nextNext === "'") {
        state = 'literal-multi';
        index += 2;
      } else if (character === '"') {
        state = 'basic';
      } else if (character === "'") {
        state = 'literal';
      } else if (character === '[') {
        squareDepth += 1;
      } else if (character === ']') {
        squareDepth -= 1;
      } else if (character === '{') {
        curlyDepth += 1;
      } else if (character === '}') {
        curlyDepth -= 1;
      }
    }
    if (state === 'none' && squareDepth <= 0 && curlyDepth <= 0) return lineIndex;
  }
  return lines.length - 1;
}

export function repairConfigRoot() {
  const configPath = path.join(getCodexHome(), 'config.toml');
  validateManagedPath(configPath);
  if (!fs.existsSync(configPath)) return false;
  try {
    const current = fs.readFileSync(configPath, 'utf8');
    const fixed = dedupeRootKeys(current);
    if (fixed === current) return false;
    atomicWriteFile(configPath, fixed);
    return true;
  } catch {
    return false;
  }
}

export function cleanModelsCache(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const cachePath = getModelsCachePath();
  validateManagedPath(cachePath, fileSystem);
  const data = readJson(cachePath, fileSystem);
  if (!data || typeof data !== 'object') return false;
  let changed = false;
  if (data._voidRoute_backup) {
    const backup = data._voidRoute_backup;
    if (Array.isArray(backup.data)) data.data = backup.data;
    if (Array.isArray(backup.models)) data.models = backup.models;
    delete data._voidRoute_backup;
    changed = true;
  }
  if (Array.isArray(data.data)) {
    const filtered = data.data.filter((item) => !(item && item.owned_by === 'voidRoute'));
    if (filtered.length !== data.data.length) { data.data = filtered; changed = true; }
  }
  if (Array.isArray(data.models)) {
    const filtered = data.models.filter((item) => !(item && item.provider_id === 'voidRoute'));
    if (filtered.length !== data.models.length) { data.models = filtered; changed = true; }
  }
  if (changed) atomicWriteFile(cachePath, JSON.stringify(data, null, 2) + '\n', options);
  return changed;
}

// Keep the startup hook compatible without creating a second, untracked backup
// that could be mistaken for the lifecycle's recovery state.
export function injectModelsCache(options = {}) {
  return new CodexLifecycle(options).refreshModelsCache().refreshed;
}

export function restoreModelsCache() {
  // Recovery is owned by CodexLifecycle. Fixed-name legacy backups are not
  // safe to restore because their generation cannot be proven.
  return false;
}

export function escapeTomlString(value) {
  const controls = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
  let output = '';
  for (const character of String(value)) {
    if (character === '\\') output += '\\\\';
    else if (character === '"') output += '\\"';
    else if (controls[character]) output += controls[character];
    else {
      const code = character.charCodeAt(0);
      output += code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
    }
  }
  return output;
}
