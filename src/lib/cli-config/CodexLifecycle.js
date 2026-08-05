import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  atomicWriteFile,
  buildCatalog,
  escapeTomlString,
  fingerprint,
  findNativeEntries,
  getCatalogPath,
  getCodexHome,
  getRecoveryDirectory,
  getStatePath,
  LOCK_FILENAME,
  LIFECYCLE_MARKER,
  RECOVERY_BACKUP_NAMES,
  RECOVERY_STATE_FILENAME,
  recoveryBackupName,
  removeManagedFile,
  remapRoutedNodePrefixes,
  isNativeCatalogEntry,
  validateCodexHome,
  validateManagedPath,
  validateRecoveryGeneration,
  validateRecoveryRoot,
} from './CodexCatalog.js';

export const CODEX_LIFECYCLE_STATE_VERSION = 3;
export const CODEX_LOCK_STALE_MS = 5 * 60 * 1000;

const CONFIG_FILENAME = 'config.toml';
const AUTH_FILENAME = 'auth.json';
const CACHE_FILENAME = 'models_cache.json';
const LEGACY_BACKUPS = Object.freeze([
  { filename: 'voidRoute-backup.json', kind: 'config' },
  { filename: 'voidRoute-models-cache-backup.json', kind: 'modelsCache' },
]);
const LEGACY_RECOVERY_DIRECTORY = '.voidRoute-codex-legacy-recovery';
const OWNED_ROOT_KEYS = new Set(['openai_base_url', 'model_provider', 'model_catalog_json', 'model']);
const MARKER_LINE = '# voidRoute proxy (OpenCodex multi-model configuration)';
const FILE_KEYS = ['config', 'auth', 'catalog', 'modelsCache'];
const FILES = {
  config: CONFIG_FILENAME,
  auth: AUTH_FILENAME,
  catalog: 'voidRoute-catalog.json',
  modelsCache: CACHE_FILENAME,
};
const STATUSES = new Set(['applying', 'applied', 'refreshing', 'resetting', 'cleaning']);
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECOVERY_ARTIFACT_PATTERN = /^(?:state\.previous|(config|auth|catalog|models-cache)\.(backup|previous))\.tmp-[A-Za-z0-9_.-]+$/;
const HOME_ARTIFACT_PATTERN = /^(?:\.voidRoute-codex-state\.json|config\.toml|auth\.json|voidRoute-catalog\.json|models_cache\.json)\.tmp-[A-Za-z0-9_.-]+$/;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function randomGeneration() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function randomLockToken() {
  return crypto.randomBytes(16).toString('hex');
}

function pathFor(home, filename) {
  return path.join(home, filename);
}

function readBuffer(file, fileSystem) {
  validateManagedPath(file, fileSystem);
  if (!fileSystem.existsSync(file)) return null;
  const stat = fileSystem.lstatSync(file);
  if (!stat.isFile()) throw new Error(`Managed Codex path is not a regular file: ${file}`);
  return Buffer.from(fileSystem.readFileSync(file));
}

function canonicalConfig(data) {
  const lines = rootSection(data.toString('utf8')).split('\n');
  const values = Object.fromEntries([...OWNED_ROOT_KEYS].map((key) => [key, []]));
  let marker = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/)?.[1];
    if (key) {
      const end = findValueEnd(lines, index);
      if (OWNED_ROOT_KEYS.has(key)) {
        const equals = line.indexOf('=');
        values[key].push(lines.slice(index, end + 1).map((valueLine, lineIndex) => (
          lineIndex === 0 ? valueLine.slice(equals + 1).trim() : valueLine.trim()
        )).join('\n'));
      }
      index = end + 1;
      continue;
    }
    if (line.trim() === MARKER_LINE) {
      marker = true;
      index += 1;
      continue;
    }
    index += 1;
  }
  return Buffer.from(JSON.stringify({ marker, values }), 'utf8');
}

function fingerprintForKey(key, data) {
  return key === 'config' ? fingerprint(canonicalConfig(data)) : fingerprint(data);
}

function snapshot(key, file, fileSystem) {
  const data = readBuffer(file, fileSystem);
  return {
    exists: data !== null,
    data,
    fingerprint: data === null ? null : fingerprintForKey(key, data),
    fullFingerprint: data === null ? null : fingerprint(data),
    byteLength: data === null ? null : data.byteLength,
  };
}

function currentFingerprint(key, file, fileSystem) {
  return snapshot(key, file, fileSystem).fingerprint;
}

function parseJsonObject(data, label) {
  if (data === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message}`);
  }
  if (!plainObject(parsed)) throw new Error(`${label} must contain a JSON object`);
  return parsed;
}

function hasLegacyModelEntries(value, field, identityFields) {
  return plainObject(value)
    && Array.isArray(value[field])
    && value[field].every((entry) => plainObject(entry)
      && identityFields.some((identity) => typeof entry[identity] === 'string' && entry[identity].length > 0));
}

function hasLegacyAuthShape(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => !['OPENAI_API_KEY', 'auth_mode'].includes(key))) {
    return false;
  }
  return Object.values(value).every((entry) => plainObject(entry)
    && typeof entry.present === 'boolean'
    && (!Object.hasOwn(entry, 'value') || typeof entry.value === 'string'));
}

function isLegacyBackupShape(value, kind) {
  if (kind === 'config') {
    return plainObject(value)
      && typeof value.rootKeys === 'string'
      && Object.keys(value).every((key) => key === 'rootKeys' || key === 'auth')
      && (!Object.hasOwn(value, 'auth') || hasLegacyAuthShape(value.auth));
  }
  return hasLegacyModelEntries(value, 'models', ['slug']) || hasLegacyModelEntries(value, 'data', ['id', 'slug']);
}

function readLegacyBackup(home, { filename, kind }, fileSystem) {
  const source = pathFor(home, filename);
  validateManagedPath(source, fileSystem);
  if (!fileSystem.existsSync(source)) return null;
  const stat = fileSystem.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing legacy Codex recovery file that is not a regular file: ${source}`);
  }
  const data = Buffer.from(fileSystem.readFileSync(source));
  let value;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new Error(`Refusing unversioned or stale Codex recovery file: ${source} (${error.message})`);
  }
  if (!isLegacyBackupShape(value, kind)) {
    throw new Error(`Refusing unversioned or stale Codex recovery file: ${source}`);
  }
  return { filename, source, data };
}

function migrateLegacyBackups(home, fileSystem) {
  const candidates = LEGACY_BACKUPS.map((legacy) => readLegacyBackup(home, legacy, fileSystem)).filter(Boolean);
  if (candidates.length === 0) return false;

  const root = validateManagedPath(path.join(home, LEGACY_RECOVERY_DIRECTORY), fileSystem);
  if (fileSystem.existsSync(root)) {
    const stat = fileSystem.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Legacy Codex recovery directory is not a regular directory: ${root}`);
    }
  } else {
    fileSystem.mkdirSync(root, { mode: 0o700 });
  }

  const generation = path.join(root, `migration-${randomGeneration()}`);
  validateManagedPath(generation, fileSystem);
  fileSystem.mkdirSync(generation, { mode: 0o700 });
  for (const candidate of candidates) {
    const target = validateManagedPath(path.join(generation, candidate.filename), fileSystem);
    fileSystem.renameSync(candidate.source, target);
    const stat = fileSystem.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Legacy Codex recovery file is not a regular file after migration: ${target}`);
    }
  }
  return true;
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

function rootSection(toml) {
  const lines = String(toml).split('\n');
  const tableIndex = lines.findIndex((line) => parseTableHeader(line));
  return lines.slice(0, tableIndex === -1 ? lines.length : tableIndex).join('\n');
}

function isOwnedTable(name) {
  return name.trim() === 'model_providers.voidRoute';
}

function stripOwnedConfig(toml) {
  const lines = String(toml).split('\n');
  const output = [];
  let inTable = false;
  let skipTable = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const header = parseTableHeader(line);
    if (header) {
      inTable = true;
      skipTable = isOwnedTable(header.name);
      if (!skipTable) output.push(line);
      index += 1;
      continue;
    }
    if (skipTable) {
      index += 1;
      continue;
    }
    if (!inTable && line.trim() === MARKER_LINE) {
      index += 1;
      continue;
    }
    if (!inTable) {
      const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/);
      if (key && OWNED_ROOT_KEYS.has(key[1])) {
        index = findValueEnd(lines, index) + 1;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function composeConfig(current, selectedModel, endpoint, catalogPath) {
  const base = stripOwnedConfig(current);
  const top = [
    MARKER_LINE,
    `model_catalog_json = "${escapeTomlString(catalogPath.replace(/\\/g, '/'))}"`,
    `openai_base_url = "${escapeTomlString(endpoint)}"`,
    'model_provider = "openai"',
    `model = "${escapeTomlString(selectedModel)}"`,
  ].join('\n');
  const firstTable = base.search(/^\s*\[\[?/m);
  if (firstTable === -1) return `${(base ? `${base}\n\n` : '') + top}\n`;
  const before = base.slice(0, firstTable).trim();
  const after = base.slice(firstTable).trim();
  return `${before ? `${before}\n\n` : ''}${top}\n\n${after}\n`;
}

function modelIdsFor({ model, providerModelsList, allModelsForProvider }) {
  const values = Array.isArray(allModelsForProvider) && allModelsForProvider.length > 0
    ? allModelsForProvider
    : Array.isArray(providerModelsList) && providerModelsList.length > 0
      ? providerModelsList.map((item) => item?.id)
      : [model];
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = String(value ?? '');
    if (!id || id.includes('\0')) throw new Error('Codex model IDs must be non-empty strings without NUL bytes');
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) throw new Error('Codex apply requires at least one model');
  return ids;
}

function filePathMap(home) {
  return Object.fromEntries(FILE_KEYS.map((key) => [key, pathFor(home, FILES[key])]));
}

function serializedState(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function statePathFingerprint(fileSystem) {
  return currentFingerprint(null, getStatePath(), fileSystem);
}

function assertExpected(actual, expected, label) {
  if (actual !== expected) throw new Error(`Concurrent edit detected in ${label}; refusing to overwrite it`);
}

function writeState(state, fileSystem, expectedFingerprint) {
  validateManagedPath(getStatePath(), fileSystem);
  assertExpected(statePathFingerprint(fileSystem), expectedFingerprint, 'Codex lifecycle state');
  if (state.status === 'applied' && state.transaction === null) {
    assertApplied(state, filePathMap(state.home), fileSystem);
  }
  const existing = readBuffer(getStatePath(), fileSystem);
  if (existing !== null) {
    const journal = path.join(stateRecoveryDirectory(state, getCodexHome(), fileSystem), RECOVERY_STATE_FILENAME);
    validateManagedPath(journal, fileSystem);
    atomicWriteFile(journal, existing, { fileSystem, mode: 0o600 });
  }
  assertExpected(statePathFingerprint(fileSystem), expectedFingerprint, 'Codex lifecycle state');
  const data = serializedState(state);
  atomicWriteFile(getStatePath(), data, { fileSystem, mode: 0o600 });
  return fingerprint(data);
}

function removeState(fileSystem, expectedFingerprint) {
  assertExpected(statePathFingerprint(fileSystem), expectedFingerprint, 'Codex lifecycle state');
  removeManagedFile(getStatePath(), fileSystem);
}

function validateRecord(record, key, kind, state, fileSystem) {
  if (!plainObject(record) || typeof record.existed !== 'boolean'
      || (record.fingerprint !== null && typeof record.fingerprint !== 'string')
      || (record.backupFingerprint !== null && typeof record.backupFingerprint !== 'string')
      || (record.backupByteLength !== null
        && (!Number.isInteger(record.backupByteLength) || record.backupByteLength < 0))) {
    throw new Error(`Codex lifecycle ${kind} recovery record is invalid for ${key}`);
  }
  const expectedNames = kind === 'previous'
    ? [recoveryBackupName('previous', key), recoveryBackupName('original', key)]
    : [recoveryBackupName(kind, key)];
  if (record.existed && !expectedNames.includes(record.backup)) {
    throw new Error(`Codex lifecycle ${kind} backup is outside the allowlist for ${key}`);
  }
  if (!record.existed && record.backup !== null) {
    throw new Error(`Codex lifecycle ${kind} absent file has a backup path for ${key}`);
  }
  if (record.existed
      && (typeof record.backupFingerprint !== 'string' || !Number.isInteger(record.backupByteLength))) {
    throw new Error(`Codex lifecycle ${kind} backup metadata is missing for ${key}`);
  }
  if (!record.existed && (record.fingerprint !== null
      || record.backupFingerprint !== null || record.backupByteLength !== null)) {
    throw new Error(`Codex lifecycle ${kind} absent file has backup metadata for ${key}`);
  }
  if (record.existed) {
    const backup = path.join(stateRecoveryDirectory(state, getCodexHome(), fileSystem), record.backup);
    validateManagedPath(backup, fileSystem);
  }
}

function stateRecoveryDirectory(state, home, fileSystem) {
  if (!plainObject(state.recovery) || typeof state.recovery.directory !== 'string') {
    throw new Error('Codex lifecycle recovery path is missing');
  }
  const generation = state.owner?.generation;
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) {
    throw new Error('Codex lifecycle recovery generation is invalid');
  }
  const root = validateRecoveryRoot(fileSystem);
  const expected = path.join(root, generation);
  if (path.normalize(state.recovery.directory) !== path.normalize(path.relative(home, expected))) {
    throw new Error('Codex lifecycle recovery path is malformed or out of generation');
  }
  if (fileSystem.existsSync(root)) {
    const otherGenerations = fileSystem.readdirSync(root).filter((entry) => entry !== generation);
    if (otherGenerations.length > 0) {
      throw new Error(`Unowned Codex recovery generation remains under CODEX_HOME: ${root}`);
    }
  }
  return validateRecoveryGeneration(expected, fileSystem, generation);
}

function validateTransaction(transaction, state, fileSystem) {
  if (transaction === null) return;
  if (!plainObject(transaction) || !['apply', 'refresh'].includes(transaction.kind)
      || !plainObject(transaction.previous) || !plainObject(transaction.previousTargets)
      || !plainObject(transaction.written) || !plainObject(transaction.restored)
      || typeof transaction.hadAppliedState !== 'boolean'
      || (transaction.writing !== null && !FILE_KEYS.includes(transaction.writing))
      || (transaction.restoring !== null && !FILE_KEYS.includes(transaction.restoring))) {
    throw new Error('Codex lifecycle transaction journal is invalid');
  }
  for (const key of FILE_KEYS) {
    validateRecord(transaction.previous[key], key, 'previous', state, fileSystem);
    if (!plainObject(transaction.previousTargets[key])
        || transaction.previousTargets[key].path !== path.join(state.home, FILES[key])
        || (transaction.previousTargets[key].fingerprint !== null
          && typeof transaction.previousTargets[key].fingerprint !== 'string')) {
      throw new Error(`Codex lifecycle previous target is invalid for ${key}`);
    }
    if (typeof transaction.written[key] !== 'boolean' || typeof transaction.restored[key] !== 'boolean') {
      throw new Error(`Codex lifecycle transaction progress is invalid for ${key}`);
    }
  }
}

function validateRestoreMap(restore) {
  if (!plainObject(restore)
      || Object.keys(restore).length !== FILE_KEYS.length
      || FILE_KEYS.some((key) => !Object.hasOwn(restore, key) || typeof restore[key] !== 'boolean')) {
    throw new Error(`Codex lifecycle state.restore is invalid; expected boolean entries for exactly: ${FILE_KEYS.join(', ')}`);
  }
}

function validateStateObject(state, fileSystem) {
  if (!plainObject(state)
      || state.version !== CODEX_LIFECYCLE_STATE_VERSION
      || state.owner?.marker !== LIFECYCLE_MARKER
      || typeof state.owner?.generation !== 'string'
      || !plainObject(state.targets)
      || !plainObject(state.original)
      || !Object.hasOwn(state, 'transaction')
      || !Object.hasOwn(state, 'restoreInProgress')
      || !STATUSES.has(state.status)) {
    throw new Error('Codex lifecycle state is invalid or belongs to another owner');
  }
  validateRestoreMap(state.restore);
  const home = getCodexHome();
  if (state.home !== home) throw new Error('Codex lifecycle state belongs to a different CODEX_HOME');
  const paths = filePathMap(home);
  for (const key of FILE_KEYS) {
    if (!plainObject(state.targets[key]) || state.targets[key].path !== paths[key]
        || (state.targets[key].fingerprint !== null && typeof state.targets[key].fingerprint !== 'string')) {
      throw new Error(`Codex lifecycle state has an invalid ${key} target`);
    }
    validateRecord(state.original[key], key, 'original', state, fileSystem);
  }
  stateRecoveryDirectory(state, home, fileSystem);
  validateTransaction(state.transaction ?? null, state, fileSystem);
  if (state.restoreInProgress !== null && !FILE_KEYS.includes(state.restoreInProgress)) {
    throw new Error('Codex lifecycle reset journal is invalid');
  }
  return state;
}

function readState(fileSystem) {
  const statePath = getStatePath();
  if (!fileSystem.existsSync(statePath)) return { state: null, fingerprint: null };
  validateManagedPath(statePath, fileSystem);
  const data = Buffer.from(fileSystem.readFileSync(statePath));
  let state;
  try {
    state = JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new Error(`Codex lifecycle state is not valid JSON: ${error.message}`);
  }
  validateStateObject(state, fileSystem);
  return { state, fingerprint: fingerprint(data) };
}

function stateBackupPath(state, key, kind, home, fileSystem) {
  const record = kind === 'original' ? state.original[key] : state.transaction?.previous[key];
  if (!record?.existed) return null;
  const expected = recoveryBackupName(kind, key);
  if (record.backup !== expected) throw new Error(`Codex lifecycle backup is not allowlisted for ${key}`);
  const backup = path.join(stateRecoveryDirectory(state, home, fileSystem), expected);
  validateManagedPath(backup, fileSystem);
  if (!fileSystem.existsSync(backup)) throw new Error(`Missing Codex recovery backup for ${key}`);
  const stat = fileSystem.lstatSync(backup);
  if (!stat.isFile()) throw new Error(`Codex recovery backup is not a regular file for ${key}`);
  return backup;
}

function assertBackupFile(backup, expectedFingerprint, expectedByteLength, fileSystem, key, expectedOwnedFingerprint = expectedFingerprint) {
  validateManagedPath(backup, fileSystem);
  if (!fileSystem.existsSync(backup)) throw new Error(`Missing Codex recovery backup for ${key}`);
  const stat = fileSystem.lstatSync(backup);
  if (!stat.isFile()) throw new Error(`Codex recovery backup is not a regular file for ${key}`);
  const data = Buffer.from(fileSystem.readFileSync(backup));
  if ((Number.isFinite(stat.size) && stat.size !== data.byteLength)
      || data.byteLength !== expectedByteLength
      || fingerprint(data) !== expectedFingerprint
      || fingerprintForKey(key, data) !== expectedOwnedFingerprint) {
    throw new Error(`Codex recovery backup fingerprint or byte length mismatch for ${key}`);
  }
}

function readVerifiedBackup(state, key, kind, home, fileSystem) {
  const record = kind === 'original' ? state.original[key] : state.transaction?.previous[key];
  const backup = stateBackupPath(state, key, kind, home, fileSystem);
  if (!backup) return null;
  const before = fileSystem.lstatSync(backup);
  const data = Buffer.from(fileSystem.readFileSync(backup));
  const after = fileSystem.lstatSync(backup);
  if (!before.isFile() || !after.isFile()
      || (Number.isFinite(before.size) && before.size !== data.byteLength)
      || (Number.isFinite(after.size) && after.size !== data.byteLength)
      || data.byteLength !== record.backupByteLength
      || fingerprint(data) !== record.backupFingerprint
      || fingerprintForKey(key, data) !== record.fingerprint) {
    throw new Error(`Codex recovery backup fingerprint or byte length mismatch for ${key}`);
  }
  return data;
}

function assertRecoveryBackups(state, home, fileSystem) {
  for (const key of FILE_KEYS) {
    readVerifiedBackup(state, key, 'original', home, fileSystem);
    if (state.transaction) {
      const record = state.transaction.previous[key];
      if (record.existed) {
        const kind = record.backup === recoveryBackupName('original', key) ? 'original' : 'previous';
        readVerifiedBackup(state, key, kind, home, fileSystem);
      }
    }
  }
}

function ownedConfigPresent(data) {
  if (!data) return false;
  let parsed;
  try {
    parsed = JSON.parse(canonicalConfig(data).toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed.marker) return false;
  for (const key of OWNED_ROOT_KEYS) {
    if (!Array.isArray(parsed.values[key]) || parsed.values[key].length === 0) return false;
  }
  return true;
}

function canonicalConfigValues(data) {
  try {
    return JSON.parse(canonicalConfig(data).toString('utf8'));
  } catch {
    return null;
  }
}

function protectedConfigProjection(data) {
  const parsed = canonicalConfigValues(data);
  if (!parsed) return null;
  return {
    marker: parsed.marker,
    values: Object.fromEntries([...OWNED_ROOT_KEYS]
      .filter((key) => key !== 'model')
      .map((key) => [key, parsed.values[key]])),
  };
}

function protectedConfigValuesMatch(current, expected) {
  const currentValues = canonicalConfigValues(current);
  if (!currentValues || !expected || currentValues.marker !== expected.marker) return false;
  return [...OWNED_ROOT_KEYS]
    .filter((key) => key !== 'model')
    .every((key) => JSON.stringify(currentValues.values[key]) === JSON.stringify(expected.values[key]));
}

function readConfigBackupLoose(state, home, fileSystem) {
  const record = state.original?.config;
  if (!record?.existed || !record.backup) return null;
  let directory;
  try {
    directory = stateRecoveryDirectory(state, home, fileSystem);
  } catch {
    return null;
  }
  const backup = path.join(directory, record.backup);
  try {
    validateManagedPath(backup, fileSystem);
    if (!fileSystem.existsSync(backup)) return null;
    const stat = fileSystem.lstatSync(backup);
    if (!stat.isFile()) return null;
    const data = Buffer.from(fileSystem.readFileSync(backup));
    if (record.backupByteLength != null && data.byteLength !== record.backupByteLength) return null;
    // Only require full-byte identity; owned fingerprint may use a newer scheme than state.
    if (record.backupFingerprint && fingerprint(data) !== record.backupFingerprint) return null;
    return data;
  } catch {
    return null;
  }
}

function shouldRebaselineConfigFingerprint(state, snap, home, fileSystem) {
  if (!snap.exists || !snap.data) return false;
  if (!ownedConfigPresent(snap.data)) return false;

  const expected = state.targets.config.fingerprint;
  // File bytes still match a stale full-file fingerprint scheme.
  if (expected === snap.fullFingerprint) return true;

  const backup = readConfigBackupLoose(state, home, fileSystem);
  const backupOwned = backup ? fingerprintForKey('config', backup) : null;
  const backupFull = backup ? fingerprint(backup) : null;
  const currentOwned = snap.fingerprint;
  // Owned keys unchanged vs recovery snapshot; target may still hold a full-file hash.
  if (backup && currentOwned === backupOwned && (expected === backupFull || expected === backupOwned)) return true;
  // Codex Desktop legitimately changes the selected root model. Keep the
  // routing-owned keys protected, but rebaseline the model-selection change.
  const baseline = state.managedConfig
    || (backup && ownedConfigPresent(backup) ? protectedConfigProjection(backup) : null);
  if (protectedConfigValuesMatch(snap.data, baseline)) return true;
  return false;
}

function assertApplied(state, paths, fileSystem) {
  let rebaselined = false;
  const home = state.home || getCodexHome();
  for (const key of FILE_KEYS) {
    const snap = snapshot(key, paths[key], fileSystem);
    const expected = state.targets[key].fingerprint;
    if (snap.fingerprint === expected) continue;
    if (key === 'config' && shouldRebaselineConfigFingerprint(state, snap, home, fileSystem)) {
      state.targets.config.fingerprint = snap.fingerprint;
      state.managedConfig = protectedConfigProjection(snap.data);
      rebaselined = true;
      continue;
    }
    throw new Error(`Concurrent edit detected in Codex ${FILES[key]}; refusing to overwrite it`);
  }
  return rebaselined;
}

function assertAppliedOrOriginal(state, paths, fileSystem) {
  for (const key of FILE_KEYS) {
    const actual = currentFingerprint(key, paths[key], fileSystem);
    const applied = state.targets[key].fingerprint;
    const original = state.original[key].fingerprint || null;
    if (actual !== applied && actual !== original) {
      throw new Error(`Concurrent edit detected in Codex ${FILES[key]}; refusing to overwrite it`);
    }
  }
}

function makeOriginalRecord(snapshotValue, key) {
  return {
    existed: snapshotValue.exists,
    fingerprint: snapshotValue.fingerprint,
    backupFingerprint: snapshotValue.fullFingerprint,
    backupByteLength: snapshotValue.byteLength,
    backup: snapshotValue.exists ? recoveryBackupName('original', key) : null,
  };
}

function makeTransaction(kind, snapshots, previous, hadAppliedState, paths) {
  return {
    kind,
    previous: Object.fromEntries(FILE_KEYS.map((key) => [key, {
      ...previous[key],
      backup: previous[key].backup,
    }])),
    previousTargets: Object.fromEntries(FILE_KEYS.map((key) => [key, {
      path: paths[key],
      fingerprint: snapshots[key].fingerprint,
    }])),
    hadAppliedState,
    writing: null,
    restoring: null,
    written: Object.fromEntries(FILE_KEYS.map((key) => [key, false])),
    restored: Object.fromEntries(FILE_KEYS.map((key) => [key, false])),
  };
}

function makeState({ home, generation, recovery, original, paths, outputs, root, transaction, status = 'applying' }) {
  return {
    version: CODEX_LIFECYCLE_STATE_VERSION,
    owner: { marker: LIFECYCLE_MARKER, generation },
    home,
    status,
    managedConfig: protectedConfigProjection(outputs.config),
    recovery,
    original: {
      ...original,
      config: {
        ...original.config,
        rootSectionFingerprint: original.config.rootSectionFingerprint || fingerprintForKey('config', Buffer.from(root, 'utf8')),
      },
    },
    targets: Object.fromEntries(FILE_KEYS.map((key) => [key, {
      path: paths[key],
      fingerprint: fingerprintForKey(key, outputs[key]),
    }])),
    transaction,
    restoreInProgress: null,
    restore: Object.fromEntries(FILE_KEYS.map((key) => [key, false])),
  };
}

function createRecovery(home, generation, snapshots, fileSystem) {
  const root = validateRecoveryRoot(fileSystem);
  if (!fileSystem.existsSync(root)) fileSystem.mkdirSync(root, { mode: 0o700 });
  const directory = path.join(root, generation);
  validateRecoveryGeneration(directory, fileSystem, generation);
  if (fileSystem.existsSync(directory)) throw new Error(`Codex recovery generation already exists: ${generation}`);
  fileSystem.mkdirSync(directory, { mode: 0o700 });
  try {
    const original = {};
    for (const key of FILE_KEYS) {
      const snapshotValue = snapshots[key];
      original[key] = makeOriginalRecord(snapshotValue, key);
      if (snapshotValue.exists) {
        const backup = path.join(directory, recoveryBackupName('original', key));
        atomicWriteFile(backup, snapshotValue.data, {
          fileSystem,
          mode: 0o600,
        });
        assertBackupFile(
          backup,
          snapshotValue.fullFingerprint,
          snapshotValue.byteLength,
          fileSystem,
          key,
          snapshotValue.fingerprint,
        );
      }
    }
    return { directory: path.relative(home, directory), original };
  } catch (error) {
    try { removeRecoveryDirectory(directory, fileSystem); } catch { /* retain evidence for fail-closed recovery */ }
    throw error;
  }
}

function adoptAppliedArtifacts(home, paths, fileSystem) {
  const snapshots = Object.fromEntries(FILE_KEYS.map((key) => [key, snapshot(key, paths[key], fileSystem)]));
  if (FILE_KEYS.some((key) => !snapshots[key].exists)) return null;

  const generation = randomGeneration();
  const created = createRecovery(home, generation, snapshots, fileSystem);
  const outputs = Object.fromEntries(FILE_KEYS.map((key) => [key, snapshots[key].data]));
  const state = makeState({
    home,
    generation,
    recovery: created,
    original: created.original,
    paths,
    outputs,
    root: rootSection(snapshots.config.data.toString('utf8')),
    transaction: null,
    status: 'applied',
  });
  try {
    const stateFingerprint = writeStateAndTrack(state, fileSystem, null);
    return { state, fingerprint: stateFingerprint };
  } catch (error) {
    try { removeRecoveryDirectory(path.join(getRecoveryDirectory(), generation), fileSystem); } catch { /* preserve evidence */ }
    throw error;
  }
}

function createPreviousBackups(state, snapshots, home, fileSystem) {
  const directory = stateRecoveryDirectory(state, home, fileSystem);
  const previous = {};
  for (const key of FILE_KEYS) {
    const filename = recoveryBackupName('previous', key);
    const backup = path.join(directory, filename);
    validateManagedPath(backup, fileSystem);
    if (fileSystem.existsSync(backup)) removeManagedFile(backup, fileSystem);
    previous[key] = {
      existed: snapshots[key].exists,
      fingerprint: snapshots[key].fingerprint,
      backupFingerprint: snapshots[key].fullFingerprint,
      backupByteLength: snapshots[key].byteLength,
      backup: snapshots[key].exists ? filename : null,
    };
    if (snapshots[key].exists) {
      atomicWriteFile(backup, snapshots[key].data, { fileSystem, mode: 0o600 });
      assertBackupFile(
        backup,
        snapshots[key].fullFingerprint,
        snapshots[key].byteLength,
        fileSystem,
        key,
        snapshots[key].fingerprint,
      );
    }
  }
  return previous;
}

function restoreRecord(record, state, key, kind, target, expected, home, fileSystem) {
  assertExpected(currentFingerprint(key, target, fileSystem), expected, `Codex ${FILES[key]}`);
  const data = readVerifiedBackup(state, key, kind, home, fileSystem);
  if (data) atomicWriteFile(target, data, { fileSystem, mode: 0o600 });
  else removeManagedFile(target, fileSystem);
}

function isAllowedRecoveryFilename(filename) {
  const names = Object.values(RECOVERY_BACKUP_NAMES).flatMap((group) => Object.values(group));
  return filename === RECOVERY_STATE_FILENAME || names.includes(filename) || RECOVERY_ARTIFACT_PATTERN.test(filename);
}

// The lstat/cleanup sequence is deliberately fail-closed, but JavaScript cannot
// eliminate filesystem TOCTOU races between those operations on the supported OSes.
function removeOwnedTemporaryArtifacts(directory, pattern, fileSystem) {
  validateManagedPath(directory, fileSystem);
  if (!fileSystem.existsSync(directory)) return;
  const removals = [];
  for (const filename of fileSystem.readdirSync(directory)) {
    if (!pattern.test(filename)) continue;
    const child = path.join(directory, filename);
    const stat = fileSystem.lstatSync(child);
    if (!stat.isFile()) throw new Error(`Refusing to remove non-file Codex temporary artifact: ${child}`);
    validateManagedPath(child, fileSystem);
    removals.push(child);
  }
  for (const child of removals) removeManagedFile(child, fileSystem);
}

function removeOwnedHomeTemporaryArtifacts(home, fileSystem) {
  removeOwnedTemporaryArtifacts(home, HOME_ARTIFACT_PATTERN, fileSystem);
}

function preflightRecoveryDirectory(directory, fileSystem) {
  const target = path.resolve(directory);
  validateRecoveryGeneration(target, fileSystem);
  if (!fileSystem.existsSync(target)) return [];
  return fileSystem.readdirSync(target).map((filename) => {
    const child = path.join(target, filename);
    const stat = fileSystem.lstatSync(child);
    if (!stat.isFile() || !isAllowedRecoveryFilename(filename)) {
      throw new Error(`Refusing to remove unknown Codex recovery artifact: ${child}`);
    }
    validateManagedPath(child, fileSystem);
    return child;
  });
}

function removeRecoveryDirectory(directory, fileSystem) {
  const target = path.resolve(directory);
  const children = preflightRecoveryDirectory(target, fileSystem);
  if (!fileSystem.existsSync(target)) return;
  for (const child of children) fileSystem.unlinkSync(child);
  fileSystem.rmdirSync(target);
}

function assertNoUnownedRecovery(home, fileSystem) {
  const root = validateRecoveryRoot(fileSystem);
  if (!fileSystem.existsSync(root)) return;
  const generations = fileSystem.readdirSync(root);
  if (generations.length > 0) {
    throw new Error(`Unowned Codex recovery generation remains under CODEX_HOME: ${root}`);
  }
}

function cleanGenerationOrphans(state, home, fileSystem) {
  const directory = stateRecoveryDirectory(state, home, fileSystem);
  if (!fileSystem.existsSync(directory)) return;
  const children = fileSystem.readdirSync(directory).map((filename) => {
    const previousNames = Object.values(RECOVERY_BACKUP_NAMES.previous);
    const child = path.join(directory, filename);
    const stat = fileSystem.lstatSync(child);
    if (!stat.isFile()) throw new Error(`Refusing to remove non-file Codex recovery artifact: ${child}`);
    validateManagedPath(child, fileSystem);
    if (!previousNames.includes(filename) && filename !== RECOVERY_STATE_FILENAME && !RECOVERY_ARTIFACT_PATTERN.test(filename)) {
      if (Object.values(RECOVERY_BACKUP_NAMES.original).includes(filename)) return null;
      throw new Error(`Unknown Codex recovery artifact remains in the active generation: ${filename}`);
    }
    return child;
  }).filter(Boolean);
  for (const child of children) fileSystem.unlinkSync(child);
}

function recoverMissingState(home, fileSystem) {
  const root = validateRecoveryRoot(fileSystem);
  if (!fileSystem.existsSync(root)) return null;
  const candidates = [];
  for (const generation of fileSystem.readdirSync(root)) {
    if (!GENERATION_PATTERN.test(generation)) throw new Error(`Malformed orphan Codex recovery path: ${generation}`);
    const directory = validateRecoveryGeneration(path.join(root, generation), fileSystem, generation);
    const journal = path.join(directory, RECOVERY_STATE_FILENAME);
    let candidate = null;
    if (fileSystem.existsSync(journal)) {
      candidate = journal;
    } else {
      const temporaryJournals = fileSystem.readdirSync(directory)
        .filter((filename) => /^state\.previous\.tmp-[A-Za-z0-9_.-]+$/.test(filename));
      if (temporaryJournals.length > 1) {
        throw new Error(`Multiple temporary Codex state recovery journals found in: ${directory}`);
      }
      if (temporaryJournals.length === 1) candidate = path.join(directory, temporaryJournals[0]);
    }
    if (!candidate) continue;
    validateManagedPath(candidate, fileSystem);
    const stat = fileSystem.lstatSync(candidate);
    if (!stat.isFile()) throw new Error(`Codex state recovery journal is not a regular file: ${candidate}`);
    candidates.push(candidate);
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) throw new Error('Multiple Codex state recovery journals found; refusing adoption');
  const data = Buffer.from(fileSystem.readFileSync(candidates[0]));
  let journalState;
  try { journalState = JSON.parse(data.toString('utf8')); } catch (error) {
    throw new Error(`Codex state recovery journal is not valid JSON: ${error.message}`);
  }
  const generation = path.basename(path.dirname(candidates[0]));
  try {
    validateStateObject(journalState, fileSystem);
  } catch (error) {
    if (error.message.includes('state.restore')) throw error;
    throw new Error(`Codex state recovery journal is malformed or belongs to another CODEX_HOME: ${error.message}`);
  }
  if (journalState.owner.generation !== generation || journalState.home !== home) {
    throw new Error('Codex state recovery journal is malformed or belongs to another CODEX_HOME');
  }
  preflightRecoveryDirectory(path.dirname(candidates[0]), fileSystem);
  validateManagedPath(getStatePath(), fileSystem);
  atomicWriteFile(getStatePath(), data, { fileSystem, mode: 0o600 });
  return readState(fileSystem);
}

function removeRecovery(state, home, fileSystem) {
  const directory = stateRecoveryDirectory(state, home, fileSystem);
  removeRecoveryDirectory(directory, fileSystem);
  const root = validateRecoveryRoot(fileSystem);
  if (fileSystem.existsSync(root) && fileSystem.readdirSync(root).length === 0) fileSystem.rmdirSync(root);
}

function removePreviousBackups(state, home, fileSystem) {
  const directory = stateRecoveryDirectory(state, home, fileSystem);
  if (!fileSystem.existsSync(directory)) return;
  const backups = [];
  for (const key of FILE_KEYS) {
    const backup = path.join(directory, recoveryBackupName('previous', key));
    validateManagedPath(backup, fileSystem);
    if (!fileSystem.existsSync(backup)) continue;
    const stat = fileSystem.lstatSync(backup);
    if (!stat.isFile()) throw new Error(`Refusing to remove non-file Codex recovery artifact: ${backup}`);
    backups.push(backup);
  }
  for (const backup of backups) removeManagedFile(backup, fileSystem);
}

function writeTarget(key, target, data, expected, fileSystem) {
  assertExpected(currentFingerprint(key, target, fileSystem), expected, `Codex ${FILES[key]}`);
  atomicWriteFile(target, data, { fileSystem, mode: 0o600 });
}

function writeStateAndTrack(state, fileSystem, expected) {
  return writeState(state, fileSystem, expected);
}

function recoverApplying(state, paths, home, fileSystem, initialStateFingerprint) {
  assertRecoveryBackups(state, home, fileSystem);
  const transaction = state.transaction;
  if (!transaction) throw new Error('Codex applying state has no recovery journal');
  let stateFingerprint = initialStateFingerprint;
  const pending = [];
  const conflicts = [];
  for (const key of FILE_KEYS) {
    const previous = transaction.previous[key];
    const previousFingerprint = transaction.previousTargets[key].fingerprint;
    const actual = currentFingerprint(key, paths[key], fileSystem);
    if (actual === previousFingerprint) continue;
    const canBeInterrupted = transaction.writing === key || transaction.restoring === key;
    if (actual !== state.targets[key].fingerprint && !(actual === null && canBeInterrupted)) {
      conflicts.push(key);
      continue;
    }
    pending.push({ key, actual, previous });
  }

  for (const { key, actual, previous } of pending) {
    transaction.restoring = key;
    transaction.writing = null;
    stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
    restoreRecord(
      previous,
      state,
      key,
      previous.backup === recoveryBackupName('original', key) ? 'original' : 'previous',
      paths[key],
      currentFingerprint(key, paths[key], fileSystem),
      home,
      fileSystem,
    );
    transaction.restoring = null;
    transaction.restored[key] = true;
    stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
  }
  if (conflicts.length > 0) {
    throw new Error(`Concurrent edit detected in Codex ${FILES[conflicts[0]]}; recovery refused`);
  }
  for (const key of FILE_KEYS) {
    assertExpected(currentFingerprint(key, paths[key], fileSystem), transaction.previousTargets[key].fingerprint, `Codex ${FILES[key]} recovery`);
  }
  if (transaction.hadAppliedState) {
    state.targets = transaction.previousTargets;
    state.transaction = null;
    state.status = 'applied';
    state.restoreInProgress = null;
    state.restore = Object.fromEntries(FILE_KEYS.map((key) => [key, false]));
    stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
    removePreviousBackups(state, home, fileSystem);
    cleanGenerationOrphans(state, home, fileSystem);
    return { state, fingerprint: stateFingerprint };
  }
  state.status = 'cleaning';
  state.transaction = null;
  stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
  removeRecovery(state, home, fileSystem);
  removeState(fileSystem, stateFingerprint);
  return { state: null, fingerprint: null };
}

function resumeReset(state, paths, home, fileSystem, initialStateFingerprint) {
  validateRestoreMap(state.restore);
  let stateFingerprint = initialStateFingerprint;
  if (state.status === 'cleaning') {
    removeRecovery(state, home, fileSystem);
    removeState(fileSystem, stateFingerprint);
    return { reset: true, state: null };
  }
  assertRecoveryBackups(state, home, fileSystem);
  if (state.status === 'applied') {
    assertAppliedOrOriginal(state, paths, fileSystem);
    state.status = 'resetting';
    stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
  }
  if (state.status !== 'resetting') throw new Error(`Cannot reset Codex lifecycle from ${state.status}`);
  for (const key of FILE_KEYS) {
    const actual = currentFingerprint(key, paths[key], fileSystem);
    const original = state.original[key].fingerprint || null;
    if (actual === original) {
      if (!state.restore[key]) {
        state.restore[key] = true;
        stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
      }
      continue;
    }
    if (actual !== state.targets[key].fingerprint
        && !(actual === null && state.restoreInProgress === key)) {
      throw new Error(`Concurrent edit detected in Codex ${FILES[key]}; refusing to overwrite it`);
    }
    state.restoreInProgress = key;
    stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
    restoreRecord(state.original[key], state, key, 'original', paths[key], currentFingerprint(key, paths[key], fileSystem), home, fileSystem);
    state.restoreInProgress = null;
    state.restore[key] = true;
    stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
  }
  state.status = 'cleaning';
  stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
  removeRecovery(state, home, fileSystem);
  removeState(fileSystem, stateFingerprint);
  return { reset: true, state: null };
}

function managedArtifactPresent(paths, fileSystem) {
  if (fileSystem.existsSync(paths.catalog)) return true;
  if (fileSystem.existsSync(paths.config)) {
    const config = fileSystem.readFileSync(paths.config, 'utf8');
    if (config.includes(MARKER_LINE)) return true;
  }
  if (fileSystem.existsSync(paths.auth)) {
    const auth = parseJsonObject(readBuffer(paths.auth, fileSystem), 'Codex auth.json');
    if (auth.OPENAI_API_KEY === 'sk_voidRoute' && auth.auth_mode === 'apikey') return true;
  }
  return false;
}

function assertNoLegacyRecovery(home, paths, fileSystem, { allowManagedArtifacts = false } = {}) {
  for (const { filename } of LEGACY_BACKUPS) {
    const file = pathFor(home, filename);
    validateManagedPath(file, fileSystem);
    if (fileSystem.existsSync(file)) throw new Error(`Refusing unversioned or stale Codex recovery file: ${file}`);
  }
  assertNoUnownedRecovery(home, fileSystem);
  if (!allowManagedArtifacts && managedArtifactPresent(paths, fileSystem)) {
    throw new Error('Codex contains voidRoute artifacts without a versioned lifecycle state; refusing to adopt them');
  }
}

function buildOutputs({ snapshots, model, endpoint, providerModelsList, allModelsForProvider, defaultModelForTool, fileSystem }) {
  const config = snapshots.config.exists ? snapshots.config.data.toString('utf8') : '';
  const auth = parseJsonObject(snapshots.auth.data, 'Codex auth.json');
  const selectedModel = String(defaultModelForTool || model || '');
  if (!selectedModel) throw new Error('Codex apply requires a selected model');
  if (typeof endpoint !== 'string' || !endpoint) throw new Error('Codex apply requires an endpoint');
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch (error) {
    throw new Error(`Codex endpoint is invalid: ${error.message}`);
  }
  if (!['http:', 'https:'].includes(endpointUrl.protocol)) throw new Error('Codex endpoint must use http or https');
  const modelIds = modelIdsFor({ model: selectedModel, providerModelsList, allModelsForProvider });
  const existingCatalog = snapshots.catalog.exists
    ? parseJsonObject(snapshots.catalog.data, 'Codex catalog')
    : null;
  const catalog = buildCatalog(modelIds, null, { fileSystem, existingCatalog });
  const catalogOutput = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  const configOutput = Buffer.from(composeConfig(config, selectedModel, endpoint, getCatalogPath()), 'utf8');
  auth.auth_mode = 'apikey';
  auth.OPENAI_API_KEY = 'sk_voidRoute';
  const authOutput = Buffer.from(`${JSON.stringify(auth, null, 2)}\n`, 'utf8');
  const cacheOutput = Buffer.from(`${JSON.stringify({
    fetched_at: '2000-01-01T00:00:00Z',
    client_version: '0.0.0',
    models: catalog.models,
  }, null, 2)}\n`, 'utf8');
  return {
    modelIds,
    outputs: { config: configOutput, auth: authOutput, catalog: catalogOutput, modelsCache: cacheOutput },
    root: rootSection(config),
  };
}

function acquireLock(home, fileSystem) {
  const lockPath = validateManagedPath(path.join(home, LOCK_FILENAME), fileSystem);
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    token: randomLockToken(),
  };
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8');
  try {
    fileSystem.writeFileSync(lockPath, bytes, { flag: 'wx', mode: 0o600 });
    return () => {
      if (!fileSystem.existsSync(lockPath)) throw new Error('Codex lifecycle lock disappeared before release');
      const current = Buffer.from(fileSystem.readFileSync(lockPath));
      if (!current.equals(bytes)) throw new Error('Codex lifecycle lock changed before release');
      fileSystem.unlinkSync(lockPath);
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fileSystem.existsSync(lockPath)) return acquireLock(home, fileSystem);
    const stat = fileSystem.lstatSync(lockPath);
    if (!stat.isFile()) throw new Error('Codex lifecycle lock is not a regular file');
    const current = Buffer.from(fileSystem.readFileSync(lockPath));
    let existing;
    try { existing = JSON.parse(current.toString('utf8')); } catch { throw new Error('Codex lifecycle lock is malformed; refusing stale recovery'); }
    const created = Date.parse(existing.createdAt);
    let alive = true;
    try {
      if (existing.hostname !== os.hostname() || !Number.isInteger(existing.pid) || existing.pid <= 0) {
        throw new Error('unsafe owner');
      }
      process.kill(existing.pid, 0);
    } catch (probeError) {
      alive = probeError.message === 'unsafe owner' || !['ESRCH', 'ENOENT'].includes(probeError.code);
    }
    if (alive || !existing.token || !Number.isFinite(created) || Date.now() - created < CODEX_LOCK_STALE_MS
        || Date.now() - stat.mtimeMs < CODEX_LOCK_STALE_MS) {
      throw new Error('Codex lifecycle is locked by another process');
    }

    const claimPath = validateManagedPath(`${lockPath}.stale-${randomLockToken()}`, fileSystem);
    try {
      fileSystem.renameSync(lockPath, claimPath);
    } catch (claimError) {
      if (claimError.code === 'ENOENT') return acquireLock(home, fileSystem);
      throw claimError;
    }

    let claimed = null;
    try {
      const claimStat = fileSystem.lstatSync(claimPath);
      if (!claimStat.isFile()) throw new Error('Codex lifecycle stale-lock claim is not a regular file');
      claimed = Buffer.from(fileSystem.readFileSync(claimPath));
      const verify = Buffer.from(fileSystem.readFileSync(claimPath));
      if (!claimed.equals(current) || !verify.equals(current)) {
        throw new Error('Codex lifecycle lock changed during stale-owner recovery');
      }
      if (fileSystem.existsSync(lockPath)) {
        fileSystem.unlinkSync(claimPath);
        throw new Error('Codex lifecycle lock changed during stale-owner recovery');
      }
      fileSystem.unlinkSync(claimPath);
    } catch (claimError) {
      if (fileSystem.existsSync(claimPath)) {
        if (claimed?.equals(current) && !fileSystem.existsSync(lockPath)) {
          try { fileSystem.renameSync(claimPath, lockPath); } catch { /* retain the claim as evidence */ }
        } else if (!claimed?.equals(current)) {
          // Do not delete bytes that were not the stale owner we assessed.
          if (fileSystem.existsSync(lockPath)) {
            throw new Error('Codex lifecycle lock changed during stale-owner recovery');
          }
          try { fileSystem.renameSync(claimPath, lockPath); } catch { /* retain the claim as evidence */ }
        }
      }
      throw claimError;
    }
    return acquireLock(home, fileSystem);
  }
}

function withLock(fileSystem, { create }, callback) {
  const home = validateCodexHome(fileSystem, { create });
  if (!fileSystem.existsSync(home)) return callback(null);
  const release = acquireLock(home, fileSystem);
  try {
    return callback(home);
  } finally {
    release();
  }
}

export class CodexLifecycle {
  constructor({ fileSystem = fs } = {}) {
    this.fileSystem = fileSystem;
  }

  apply({ model, endpoint, providerModelsList = [], allModelsForProvider = null, defaultModelForTool = null }) {
    return withLock(this.fileSystem, { create: true }, (home) => {
      const fileSystem = this.fileSystem;
      const paths = filePathMap(home);
      for (const file of Object.values(paths)) validateManagedPath(file, fileSystem);
      const migratedLegacy = migrateLegacyBackups(home, fileSystem);
      let record = readState(fileSystem);
      if (!record.state) record = recoverMissingState(home, fileSystem) || record;
      if (record.state?.status === 'applying' || record.state?.status === 'refreshing') {
        record = recoverApplying(record.state, paths, home, fileSystem, record.fingerprint);
      } else if (record.state?.status === 'resetting' || record.state?.status === 'cleaning') {
        record = resumeReset(record.state, paths, home, fileSystem, record.fingerprint);
      }
      if (record.state) {
        cleanGenerationOrphans(record.state, home, fileSystem);
        removeOwnedHomeTemporaryArtifacts(home, fileSystem);
      } else if (record.state === null) {
        assertNoLegacyRecovery(home, paths, fileSystem, { allowManagedArtifacts: migratedLegacy });
      }
      const existingState = record.state;
      if (existingState) assertApplied(existingState, paths, fileSystem);
      const snapshots = Object.fromEntries(FILE_KEYS.map((key) => [key, snapshot(key, paths[key], fileSystem)]));
      const result = buildOutputs({
        snapshots,
        model,
        endpoint,
        providerModelsList,
        allModelsForProvider,
        defaultModelForTool,
        fileSystem,
      });
      let generation;
      let recovery;
      let original;
      let previous;
      let createdRecovery = false;
      if (existingState) {
        generation = existingState.owner.generation;
        recovery = existingState.recovery;
        original = existingState.original;
        try {
          previous = createPreviousBackups(existingState, snapshots, home, fileSystem);
        } catch (error) {
          try { removePreviousBackups(existingState, home, fileSystem); } catch { /* preserve the applied state */ }
          throw error;
        }
      } else {
        generation = randomGeneration();
        const created = createRecovery(home, generation, snapshots, fileSystem);
        recovery = created;
        original = created.original;
        previous = Object.fromEntries(FILE_KEYS.map((key) => [key, {
          ...original[key],
          backup: original[key].backup,
        }]));
        createdRecovery = true;
      }
      const transaction = makeTransaction('apply', snapshots, previous, Boolean(existingState), paths);
      const state = makeState({
        home,
        generation,
        recovery,
        original,
        paths,
        outputs: result.outputs,
        root: result.root,
        transaction,
      });
      let stateFingerprint = record.fingerprint;
      let stateWritten = false;
      try {
        stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
        stateWritten = true;
        for (const key of FILE_KEYS) {
          transaction.writing = key;
          stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
          writeTarget(key, paths[key], result.outputs[key], snapshots[key].fingerprint, fileSystem);
          transaction.writing = null;
          transaction.written[key] = true;
          stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
        }
        assertApplied(state, paths, fileSystem);
        state.status = 'applied';
        state.transaction = null;
        stateFingerprint = writeStateAndTrack(state, fileSystem, stateFingerprint);
        if (existingState) removePreviousBackups(state, home, fileSystem);
        cleanGenerationOrphans(state, home, fileSystem);
        removeOwnedHomeTemporaryArtifacts(home, fileSystem);
        return { modelIds: result.modelIds, catalogPath: paths.catalog, cacheInjected: true };
      } catch (error) {
        let recoveryError = null;
        try {
          if (stateWritten) {
            const latest = readState(fileSystem);
            if (!latest.state) throw new Error('Lifecycle state disappeared during apply failure recovery');
            recoverApplying(latest.state, paths, home, fileSystem, latest.fingerprint);
          } else if (createdRecovery) {
            removeRecoveryDirectory(path.join(getRecoveryDirectory(), generation), fileSystem);
          } else {
            removePreviousBackups(existingState, home, fileSystem);
          }
        } catch (restoreError) {
          recoveryError = restoreError;
        }
        if (recoveryError) throw new Error(`${error.message}; recovery failed: ${recoveryError.message}`);
        throw error;
      }
    });
  }

  reset() {
    return withLock(this.fileSystem, { create: false }, (home) => {
      if (!home) return { reset: false };
      const fileSystem = this.fileSystem;
      const paths = filePathMap(home);
      for (const file of Object.values(paths)) validateManagedPath(file, fileSystem);
      const migratedLegacy = migrateLegacyBackups(home, fileSystem);
      let record = readState(fileSystem);
      if (!record.state) record = recoverMissingState(home, fileSystem) || record;
      if (!record.state) {
        assertNoLegacyRecovery(home, paths, fileSystem, { allowManagedArtifacts: migratedLegacy });
        return { reset: false };
      }
      if (record.state.status === 'applying' || record.state.status === 'refreshing') {
        record = recoverApplying(record.state, paths, home, fileSystem, record.fingerprint);
        if (!record.state) return { reset: true };
      }
      cleanGenerationOrphans(record.state, home, fileSystem);
      removeOwnedHomeTemporaryArtifacts(home, fileSystem);
      return resumeReset(record.state, paths, home, fileSystem, record.fingerprint);
    });
  }

  refreshModelsCache() {
    const result = this.#refreshOrRepairModelsCache({ repair: false });
    return { refreshed: Boolean(result.refreshed) };
  }

  /**
   * One-shot startup/CLI repair: rebaseline stale config fingerprints when owned
   * keys are intact, and rebuild a route-only catalog from native sources.
   *
   * `providerNodes` (optional) is a list of registered provider nodes; when
   * provided, routed catalog slugs are built with the node's short prefix
   * instead of the raw node id.
   */
  repairCatalogNow(options = {}) {
    const result = this.#refreshOrRepairModelsCache({ repair: true, ...options });
    return {
      refreshed: Boolean(result.refreshed),
      repaired: Boolean(result.repaired),
    };
  }

  #refreshOrRepairModelsCache({ repair, providerNodes }) {
    return withLock(this.fileSystem, { create: false }, (home) => {
      if (!home) return { refreshed: false, repaired: false };
      const fileSystem = this.fileSystem;
      const paths = filePathMap(home);
      for (const file of Object.values(paths)) validateManagedPath(file, fileSystem);
      const migratedLegacy = migrateLegacyBackups(home, fileSystem);
      let record = readState(fileSystem);
      if (!record.state) record = recoverMissingState(home, fileSystem) || record;
      if (!record.state && migratedLegacy && managedArtifactPresent(paths, fileSystem)) {
        record = adoptAppliedArtifacts(home, paths, fileSystem);
      }
      if (!record.state) {
        assertNoLegacyRecovery(home, paths, fileSystem);
        return { refreshed: false, repaired: false };
      }
      if (record.state.status === 'applying' || record.state.status === 'refreshing') {
        record = recoverApplying(record.state, paths, home, fileSystem, record.fingerprint);
      } else if (record.state.status === 'resetting' || record.state.status === 'cleaning') {
        record = resumeReset(record.state, paths, home, fileSystem, record.fingerprint);
        if (!record.state) return { refreshed: false, repaired: false };
      }
      cleanGenerationOrphans(record.state, home, fileSystem);
      removeOwnedHomeTemporaryArtifacts(home, fileSystem);
      const state = record.state;
      const rebaselined = assertApplied(state, paths, fileSystem);
      let stateFingerprint = record.fingerprint;
      if (rebaselined) {
        stateFingerprint = writeState(state, fileSystem, stateFingerprint);
      }
      const snapshots = Object.fromEntries(FILE_KEYS.map((key) => [key, snapshot(key, paths[key], fileSystem)]));
      let catalog = parseJsonObject(snapshots.catalog.data, 'Codex catalog');
      if (!Array.isArray(catalog.models)) return { refreshed: false, repaired: rebaselined };
      let catalogOutput = snapshots.catalog.data;
      let catalogChanged = false;
      const nativeCount = catalog.models.filter(isNativeCatalogEntry).length;
      if (nativeCount === 0 || repair) {
        const nativeEntries = findNativeEntries(fileSystem, catalog);
        if (nativeEntries.length > 0) {
          const routedModelIds = remapRoutedNodePrefixes(
            catalog.models
              .filter((entry) => entry && typeof entry.slug === 'string' && entry.slug.includes('/'))
              .map((entry) => entry.slug),
            providerNodes && providerNodes.length
              ? Object.fromEntries(providerNodes.map((node) => [node.id, node.prefix || node.name]).filter(([, prefix]) => prefix))
              : null
          );
          catalog = buildCatalog(routedModelIds, null, {
            fileSystem,
            existingCatalog: catalog,
            nativeEntries,
          });
          catalogOutput = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
          catalogChanged = !catalogOutput.equals(snapshots.catalog.data);
        }
      }
      const cacheOutput = Buffer.from(`${JSON.stringify({
        fetched_at: '2000-01-01T00:00:00Z',
        client_version: '0.0.0',
        models: catalog.models,
      }, null, 2)}\n`, 'utf8');
      if (!catalogChanged && fingerprint(cacheOutput) === currentFingerprint('modelsCache', paths.modelsCache, fileSystem)) {
        return { refreshed: true, repaired: rebaselined || catalogChanged };
      }
      let previous;
      try {
        previous = createPreviousBackups(state, snapshots, home, fileSystem);
      } catch (error) {
        try { removePreviousBackups(state, home, fileSystem); } catch { /* preserve the applied state */ }
        throw error;
      }
      const outputs = {
        config: snapshots.config.data || Buffer.from('', 'utf8'),
        auth: snapshots.auth.data || Buffer.from('{}\n', 'utf8'),
        catalog: catalogOutput,
        modelsCache: cacheOutput,
      };
      const transaction = makeTransaction('refresh', snapshots, previous, true, paths);
      const nextState = makeState({
        home,
        generation: state.owner.generation,
        recovery: state.recovery,
        original: state.original,
        paths,
        outputs,
        root: rootSection(snapshots.config.data?.toString('utf8') || ''),
        transaction,
        status: 'refreshing',
      });
      stateFingerprint = writeState(nextState, fileSystem, stateFingerprint);
      try {
        const keysToWrite = catalogChanged ? ['catalog', 'modelsCache'] : ['modelsCache'];
        for (const key of keysToWrite) {
          transaction.writing = key;
          stateFingerprint = writeState(nextState, fileSystem, stateFingerprint);
          writeTarget(key, paths[key], outputs[key], snapshots[key].fingerprint, fileSystem);
          transaction.writing = null;
          transaction.written[key] = true;
          stateFingerprint = writeState(nextState, fileSystem, stateFingerprint);
        }
        assertApplied(nextState, paths, fileSystem);
        nextState.status = 'applied';
        nextState.transaction = null;
        writeState(nextState, fileSystem, stateFingerprint);
        removePreviousBackups(nextState, home, fileSystem);
        cleanGenerationOrphans(nextState, home, fileSystem);
        removeOwnedHomeTemporaryArtifacts(home, fileSystem);
        return { refreshed: true, repaired: rebaselined || catalogChanged };
      } catch (error) {
        const latest = readState(fileSystem);
        if (latest.state) recoverApplying(latest.state, paths, home, fileSystem, latest.fingerprint);
        throw error;
      }
    });
  }
}

export function createCodexLifecycle(options = {}) {
  return new CodexLifecycle(options);
}

export function applyCodexConfig(options, lifecycleOptions = {}) {
  return new CodexLifecycle(lifecycleOptions).apply(options);
}

export function resetCodexConfig(lifecycleOptions = {}) {
  return new CodexLifecycle(lifecycleOptions).reset();
}
