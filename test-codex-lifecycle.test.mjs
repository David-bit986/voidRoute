import assert from 'node:assert/strict';
import { afterEach, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodexLifecycle,
  CODEX_LIFECYCLE_STATE_VERSION,
} from './src/lib/cli-config/CodexLifecycle.js';
import {
  getCatalogPath,
  getRecoveryDirectory,
  getStatePath,
  injectModelsCache,
  LOCK_FILENAME,
  remapRoutedNodePrefixes,
  escapeTomlString,
} from './src/lib/cli-config/CodexCatalog.js';

const originalCodexHome = process.env.CODEX_HOME;

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createCodexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voidroute-codex-'));
  process.env.CODEX_HOME = home;
  return home;
}

function applyArgs(model = 'routed-model') {
  return {
    model,
    endpoint: 'http://127.0.0.1:20130/v1',
    providerModelsList: [],
    allModelsForProvider: [model],
  };
}

function nativeModels() {
  const base = {
    display_name: 'Native Codex model',
    description: 'Native metadata must remain unchanged',
    base_instructions: 'Native instructions',
    model_messages: { instructions_template: 'native-only' },
    tool_mode: 'native-tool-mode',
    default_reasoning_level: 'max',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Native low' },
      { effort: 'max', description: 'Native max' },
    ],
    input_modalities: ['text'],
    context_window: 123456,
    max_context_window: 123456,
    visibility: 'list',
    wire_api: 'responses',
    native_marker: 'preserve-me',
  };
  return [
    { ...base, slug: 'native-gpt', provider_id: 'openai' },
    { ...base, slug: 'native-codex' },
  ];
}

function assertCodexReasoningMetadata(model) {
  const efforts = model.supported_reasoning_levels.map((level) => level.effort);
  assert.equal(efforts.includes('max'), false);
  assert.equal(efforts.includes('ultra'), false);
  assert.ok(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(model.default_reasoning_level));
  assert.ok(efforts.includes(model.default_reasoning_level));
}

function resetEnvironment(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* cleanup only */ }
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

test('apply/reset preserves config, auth, cache, and table-scoped model keys', () => {
  const home = createCodexHome();
  const config = [
    'model_reasoning_effort = "low"',
    'model = "user-model"',
    'model_provider = "user-provider"',
    'model_catalog_json = "user-catalog.json"',
    'openai_base_url = "https://example.invalid/v1"',
    '',
    '[projects.example]',
    'model = "project-model"',
    'model_provider = "project-provider"',
    'model_catalog_json = "project-catalog.json"',
    'openai_base_url = "https://project.invalid/v1"',
    '',
  ].join('\n');
  const auth = {
    OPENAI_API_KEY: 'pre-existing-key',
    auth_mode: 'chatgpt',
    other_state: 'keep-me',
  };
  const cache = {
    fetched_at: '2026-08-01T00:00:00.000Z',
    models: [{ slug: 'native-model', base_instructions: 'Native Codex' }],
  };
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    writeJson(path.join(home, 'auth.json'), auth);
    writeJson(path.join(home, 'models_cache.json'), cache);
    const lifecycle = new CodexLifecycle();

    lifecycle.apply(applyArgs('provider/routed-model'));
    const state = readJson(getStatePath());
    assert.equal(state.version, CODEX_LIFECYCLE_STATE_VERSION);
    assert.equal(state.owner.marker, 'voidRoute.codex.lifecycle.v1');
    assert.equal(JSON.stringify(state).includes('pre-existing-key'), false);
    const authBackupMode = fs.statSync(path.join(home, state.recovery.directory, 'auth.backup')).mode & 0o077;
    assert.equal(process.platform === 'win32' || authBackupMode === 0, true);
    assert.deepEqual(readJson(path.join(home, 'auth.json')), {
      OPENAI_API_KEY: 'sk_voidRoute',
      auth_mode: 'apikey',
      other_state: 'keep-me',
    });
    const appliedConfig = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.match(appliedConfig, /\[projects\.example\][\s\S]*model = "project-model"/);
    assert.match(appliedConfig, /\[projects\.example\][\s\S]*model_provider = "project-provider"/);

    lifecycle.reset();
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    assert.deepEqual(readJson(path.join(home, 'auth.json')), auth);
    assert.deepEqual(readJson(path.join(home, 'models_cache.json')), cache);
    assert.equal(fs.existsSync(getCatalogPath()), false);
    assert.equal(fs.existsSync(getStatePath()), false);
    assert.equal(fs.existsSync(getRecoveryDirectory()), false);
    assert.deepEqual(lifecycle.reset(), { reset: false });
  } finally {
    resetEnvironment(home);
  }
});

test('stale fixed-name recovery data fails closed instead of restoring old state', () => {
  const home = createCodexHome();
  try {
    const configPath = path.join(home, 'config.toml');
    const staleBackup = path.join(home, 'voidRoute-backup.json');
    const config = 'preferred_auth_method = "chatgpt"\n';
    fs.writeFileSync(configPath, config);
    writeJson(staleBackup, { rootKeys: { model: 'old-model' } });
    const lifecycle = new CodexLifecycle();

    assert.throws(() => lifecycle.reset(), /stale Codex recovery file/);
    assert.throws(() => lifecycle.apply(applyArgs()), /stale Codex recovery file/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), config);
    assert.equal(fs.existsSync(staleBackup), true);
  } finally {
    resetEnvironment(home);
  }
});

test('root cleanup never removes model-like keys inside Codex tables', () => {
  const home = createCodexHome();
  const config = [
    'model = "root-model"',
    '',
    '[projects.example]',
    'model = "project-model"',
    'model_provider = "project-provider"',
    'model_catalog_json = "project-catalog.json"',
    'openai_base_url = "https://project.invalid/v1"',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const applied = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.match(applied, /\[projects\.example\][\s\S]*model = "project-model"/);
    assert.match(applied, /\[projects\.example\][\s\S]*model_provider = "project-provider"/);
    assert.match(applied, /\[projects\.example\][\s\S]*model_catalog_json = "project-catalog\.json"/);
    assert.match(applied, /\[projects\.example\][\s\S]*openai_base_url = "https:\/\/project\.invalid\/v1"/);
    lifecycle.reset();
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
  } finally {
    resetEnvironment(home);
  }
});

test('reset refuses a concurrent config edit and keeps recovery state', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const configPath = path.join(home, 'config.toml');
    const applied = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, applied.replace(
      'openai_base_url = "http://127.0.0.1:20130/v1"',
      'openai_base_url = "https://edited.example/v1"',
    ));

    assert.throws(() => lifecycle.reset(), /Concurrent edit detected/);
    assert.equal(fs.existsSync(getStatePath()), true);
    fs.writeFileSync(configPath, applied);
    lifecycle.reset();
    assert.equal(fs.existsSync(getStatePath()), false);
  } finally {
    resetEnvironment(home);
  }
});

test('partial apply rolls already-written files back', () => {
  const home = createCodexHome();
  const originals = {
    config: 'preferred_auth_method = "chatgpt"\n',
    auth: { OPENAI_API_KEY: 'pre-existing-key', auth_mode: 'chatgpt' },
    cache: { models: [{ slug: 'native-model', base_instructions: 'Native Codex' }] },
  };
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), originals.config);
    writeJson(path.join(home, 'auth.json'), originals.auth);
    writeJson(path.join(home, 'models_cache.json'), originals.cache);
    let renames = 0;
    const failingFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (...args) => {
            renames += 1;
            if (renames === 6) {
              const error = new Error('injected partial-write failure');
              error.code = 'EIO';
              throw error;
            }
            return target.renameSync(...args);
          };
        }
        return target[property];
      },
    });
    const lifecycle = new CodexLifecycle({ fileSystem: failingFileSystem });
    assert.throws(() => lifecycle.apply(applyArgs()), /partial-write failure/);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), originals.config);
    assert.deepEqual(readJson(path.join(home, 'auth.json')), originals.auth);
    assert.deepEqual(readJson(path.join(home, 'models_cache.json')), originals.cache);
    assert.equal(fs.existsSync(getStatePath()), false);
    assert.equal(fs.existsSync(getRecoveryDirectory()), false);
  } finally {
    resetEnvironment(home);
  }
});

test('reset restores the complete auth file, including pre-existing credentials and auth_mode', () => {
  const home = createCodexHome();
  const auth = {
    OPENAI_API_KEY: 'keep-this-secret',
    auth_mode: 'chatgpt',
    refresh_token: 'keep-this-too',
  };
  try {
    writeJson(path.join(home, 'auth.json'), auth);
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    assert.equal(readJson(path.join(home, 'auth.json')).OPENAI_API_KEY, 'sk_voidRoute');
    lifecycle.reset();
    assert.deepEqual(readJson(path.join(home, 'auth.json')), auth);
    assert.equal(fs.existsSync(getRecoveryDirectory()), false);
  } finally {
    resetEnvironment(home);
  }
});

test('reset removes a cache that did not exist before apply', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    assert.equal(fs.existsSync(path.join(home, 'models_cache.json')), true);
    lifecycle.reset();
    assert.equal(fs.existsSync(path.join(home, 'models_cache.json')), false);
  } finally {
    resetEnvironment(home);
  }
});

test('routed catalog entries have strict opencodex capabilities and required fields', () => {
  const home = createCodexHome();
  try {
    writeJson(path.join(home, 'models.json'), {
      models: [{
        slug: 'native-model',
        provider_id: 'openai',
        base_instructions: 'Native Codex',
        model_messages: { instructions_template: 'native-only' },
        tool_mode: 'code_mode_only',
        multi_agent_version: 'v2',
        use_responses_lite: true,
        supports_websockets: true,
        supported_reasoning_levels: [
          { effort: 'low', description: 'low' },
          { effort: 'ultra', description: 'ultra' },
          { effort: 'invalid', description: 'invalid' },
        ],
        default_reasoning_level: 'max',
        input_modalities: ['text', 'video', 'image'],
      }],
    });
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('provider/routed-model'));
    const routed = readJson(getCatalogPath()).models.find((model) => model.slug === 'provider/routed-model');
    for (const field of ['model_messages', 'tool_mode', 'multi_agent_version', 'use_responses_lite', 'supports_websockets']) {
      assert.equal(Object.hasOwn(routed, field), false, `${field} should not leak into routed entries`);
    }
    assert.equal(routed.visibility, 'list');
    assert.equal(routed.supports_reasoning_summaries, false);
    assert.deepEqual(routed.input_modalities, ['text', 'image']);
    assert.deepEqual(routed.supported_reasoning_levels.map((level) => level.effort), ['low', 'xhigh', 'medium']);
    assert.equal(routed.default_reasoning_level, 'xhigh');
    lifecycle.reset();
  } finally {
    resetEnvironment(home);
  }
});

test('native catalog entries use the effort enum accepted by the installed Codex parser', () => {
  const home = createCodexHome();
  const native = nativeModels();
  try {
    writeJson(path.join(home, 'models.json'), { models: native });
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('ag/selected-model'));

    const catalog = readJson(getCatalogPath());
    for (const model of catalog.models) assertCodexReasoningMetadata(model);
    assert.equal(catalog.models[0].native_marker, 'preserve-me');
    assert.deepEqual(catalog.models[0].model_messages, native[0].model_messages);
    assert.equal(catalog.models[0].default_reasoning_level, 'xhigh');
    assert.deepEqual(catalog.models[0].supported_reasoning_levels.map((level) => level.effort), ['low', 'xhigh']);
    lifecycle.reset();
  } finally {
    resetEnvironment(home);
  }
});

test('catalog and cache preserve native entries and only selected routed provider models', () => {
  const home = createCodexHome();
  const native = nativeModels();
  try {
    writeJson(path.join(home, 'models.json'), { models: native });
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('cc/other-provider-model'));
    lifecycle.apply({
      model: 'ag/selected-model',
      endpoint: 'http://127.0.0.1:20130/v1',
      providerModelsList: [{ id: 'ag/selected-model' }, { id: 'ag/second-model' }],
      allModelsForProvider: ['ag/selected-model', 'ag/second-model'],
    });

    const catalog = readJson(getCatalogPath());
    const cache = readJson(path.join(home, 'models_cache.json'));
    const slugs = catalog.models.map((model) => model.slug);
    assert.deepEqual(slugs, ['native-gpt', 'native-codex', 'ag/selected-model', 'ag/second-model']);
    assert.equal(slugs.includes('cc/other-provider-model'), false);
    assert.equal(new Set(slugs).size, slugs.length);
    assert.equal(catalog.models[0].native_marker, native[0].native_marker);
    assert.equal(catalog.models[1].native_marker, native[1].native_marker);
    assertCodexReasoningMetadata(catalog.models[0]);
    assertCodexReasoningMetadata(catalog.models[1]);
    assert.equal(Object.hasOwn(catalog.models[2], 'model_messages'), false);
    assert.equal(catalog.models[2].default_reasoning_level, 'xhigh');
    assert.deepEqual(cache.models, catalog.models);
  } finally {
    resetEnvironment(home);
  }
});

test('refresh repairs an applied route-only catalog with native models transactionally', () => {
  const home = createCodexHome();
  const native = nativeModels();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('ag/selected-model'));
    assert.deepEqual(readJson(getCatalogPath()).models.map((model) => model.slug), ['ag/selected-model']);

    writeJson(path.join(home, 'models.json'), { models: native });
    assert.deepEqual(lifecycle.refreshModelsCache(), { refreshed: true });

    const catalog = readJson(getCatalogPath());
    const cache = readJson(path.join(home, 'models_cache.json'));
    assert.deepEqual(catalog.models.map((model) => model.slug), ['native-gpt', 'native-codex', 'ag/selected-model']);
    assert.equal(catalog.models[0].native_marker, native[0].native_marker);
    assert.equal(catalog.models[1].native_marker, native[1].native_marker);
    assertCodexReasoningMetadata(catalog.models[0]);
    assertCodexReasoningMetadata(catalog.models[1]);
    assert.deepEqual(cache.models, catalog.models);
  } finally {
    resetEnvironment(home);
  }
});

test('repair restores natives from opencodex-catalog and drops other routed providers', () => {
  const home = createCodexHome();
  const native = [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'Native OpenAI',
      base_instructions: 'Native',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'medium', description: 'm' }],
      input_modalities: ['text', 'image'],
      context_window: 200000,
      max_context_window: 200000,
      visibility: 'list',
      provider_id: 'openai',
      wire_api: 'responses',
    },
  ];
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply({
      model: 'ag/selected-model',
      endpoint: 'http://127.0.0.1:20130/v1',
      providerModelsList: [{ id: 'ag/selected-model' }, { id: 'ag/second-model' }],
      allModelsForProvider: ['ag/selected-model', 'ag/second-model'],
    });

    // Simulate a polluted route-only catalog/cache and non-native models.json.
    writeJson(path.join(home, 'models.json'), {
      models: [{ slug: 'deepseek-v4-flash', display_name: 'DeepSeek', description: 'x', base_instructions: 'x', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: '' }], input_modalities: ['text'], context_window: 1, max_context_window: 1, visibility: 'list', provider_id: 'openai', wire_api: 'responses' }],
    });
    writeJson(path.join(home, 'opencodex-catalog.json'), { models: native });
    const polluted = {
      fetched_at: '2000-01-01T00:00:00Z',
      client_version: '0.0.0',
      models: [
        { slug: 'ag/selected-model', display_name: 'ag/selected-model', description: 'Routed via voidRoute', base_instructions: 'x', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: '' }], input_modalities: ['text'], context_window: 200000, max_context_window: 200000, visibility: 'list', provider_id: 'openai', wire_api: 'responses' },
        { slug: 'ag/second-model', display_name: 'ag/second-model', description: 'Routed via voidRoute', base_instructions: 'x', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: '' }], input_modalities: ['text'], context_window: 200000, max_context_window: 200000, visibility: 'list', provider_id: 'openai', wire_api: 'responses' },
        { slug: 'cc/other-provider-model', display_name: 'cc/other-provider-model', description: 'Routed via voidRoute', base_instructions: 'x', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: '' }], input_modalities: ['text'], context_window: 200000, max_context_window: 200000, visibility: 'list', provider_id: 'openai', wire_api: 'responses' },
      ],
    };
    writeJson(getCatalogPath(), polluted);
    writeJson(path.join(home, 'models_cache.json'), polluted);
    const state = readJson(getStatePath());
    const fp = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    state.targets.catalog.fingerprint = fp(fs.readFileSync(getCatalogPath()));
    state.targets.modelsCache.fingerprint = fp(fs.readFileSync(path.join(home, 'models_cache.json')));
    fs.writeFileSync(getStatePath(), `${JSON.stringify(state, null, 2)}\n`);

    const result = lifecycle.repairCatalogNow();
    assert.equal(result.refreshed, true);
    assert.equal(result.repaired, true);

    const catalog = readJson(getCatalogPath());
    const slugs = catalog.models.map((model) => model.slug);
    assert.deepEqual(slugs, ['deepseek-v4-flash', 'gpt-5.5', 'ag/selected-model', 'ag/second-model']);
    assert.equal(slugs.includes('cc/other-provider-model'), false);
    assert.equal(catalog.models.find((model) => model.slug === 'gpt-5.5')?.display_name, 'GPT-5.5');
    assert.deepEqual(readJson(path.join(home, 'models_cache.json')).models, catalog.models);
  } finally {
    resetEnvironment(home);
  }
});

test('refresh rebaselines stale full-file config fingerprint when owned keys intact', () => {
  const home = createCodexHome();
  const config = [
    '[marketplaces.example]',
    'name = "before-refresh"',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('ag/selected-model'));

    const configPath = path.join(home, 'config.toml');
    const applied = fs.readFileSync(configPath);
    const fullFp = crypto.createHash('sha256').update(applied).digest('hex');
    const statePath = getStatePath();
    const state = readJson(statePath);
    // Simulate an older lifecycle that stored full-file config fingerprints.
    state.targets.config.fingerprint = fullFp;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    fs.writeFileSync(configPath, applied.toString('utf8').replace('name = "before-refresh"', 'name = "after-refresh"'));
    // Keep recovery original backup aligned with the last applied owned keys (live failure mode).
    const backupPath = path.join(home, state.recovery.directory, 'config.backup');
    fs.writeFileSync(backupPath, applied);
    state.original.config.backupFingerprint = fullFp;
    state.original.config.backupByteLength = applied.byteLength;
    state.original.config.fingerprint = fullFp;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    assert.deepEqual(lifecycle.refreshModelsCache(), { refreshed: true });
    const next = readJson(statePath);
    assert.notEqual(next.targets.config.fingerprint, fullFp);
    writeJson(path.join(home, 'models.json'), { models: nativeModels() });
    assert.deepEqual(lifecycle.refreshModelsCache(), { refreshed: true });
    assert.ok(readJson(getCatalogPath()).models.some((model) => model.slug === 'native-gpt'));
  } finally {
    resetEnvironment(home);
  }
});

test('refresh accepts Codex Desktop model selection changes while protecting routing keys', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('ag/selected-model'));
    const configPath = path.join(home, 'config.toml');
    const current = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, current.replace(
      'model = "ag/selected-model"',
      'model = "gpt-5.6-luna"',
    ));

    assert.deepEqual(lifecycle.refreshModelsCache(), { refreshed: true });
    assert.match(fs.readFileSync(configPath, 'utf8'), /model = "gpt-5\.6-luna"/);

    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace(
      'openai_base_url = "http://127.0.0.1:20130/v1"',
      'openai_base_url = "https://edited.example/v1"',
    ));
    assert.throws(() => lifecycle.refreshModelsCache(), /Concurrent edit detected/);
  } finally {
    resetEnvironment(home);
  }
});

test('refresh ignores marketplace edits but rejects owned config edits', () => {
  const home = createCodexHome();
  const config = [
    '[marketplaces.example]',
    'name = "before-refresh"',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('ag/selected-model'));

    const configPath = path.join(home, 'config.toml');
    const appliedConfig = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, appliedConfig.replace('name = "before-refresh"', 'name = "after-refresh"'));
    writeJson(path.join(home, 'models.json'), { models: nativeModels() });

    assert.deepEqual(lifecycle.refreshModelsCache(), { refreshed: true });

    const editedConfig = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, editedConfig.replace(
      'openai_base_url = "http://127.0.0.1:20130/v1"',
      'openai_base_url = "https://edited.example/v1"',
    ));
    assert.throws(() => lifecycle.refreshModelsCache(), /Concurrent edit detected/);
  } finally {
    resetEnvironment(home);
  }
});

test('TOML strings escape quote, newline, endpoint, and Windows path data', () => {
  const home = createCodexHome();
  const maliciousModel = 'bad"model\nmodel_provider = "attacker"';
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply({
      model: maliciousModel,
      endpoint: 'http://127.0.0.1:20130/v1',
      providerModelsList: [],
      allModelsForProvider: [maliciousModel],
    });
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.match(config, /model = "bad\\"model\\nmodel_provider = \\"attacker\\""/);
    assert.equal(config.includes('\nmodel_provider = "attacker"\n'), false);
    assert.equal(JSON.parse(fs.readFileSync(getCatalogPath(), 'utf8')).models[0].slug, maliciousModel);
    lifecycle.reset();
  } finally {
    resetEnvironment(home);
  }
});

test('re-apply keeps the original pre-voidRoute snapshot', () => {
  const home = createCodexHome();
  const originalConfig = 'preferred_auth_method = "chatgpt"\n';
  const originalAuth = { OPENAI_API_KEY: 'original-secret', auth_mode: 'chatgpt', refresh_token: 'keep' };
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), originalConfig);
    writeJson(path.join(home, 'auth.json'), originalAuth);
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('first/model'));
    const firstApplied = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    lifecycle.apply(applyArgs('second/model'));
    const state = readJson(getStatePath());
    assert.equal(state.status, 'applied');
    assert.equal(readJson(path.join(home, state.recovery.directory, 'auth.backup')).OPENAI_API_KEY, 'original-secret');
    assert.notEqual(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), firstApplied);
    lifecycle.reset();
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), originalConfig);
    assert.deepEqual(readJson(path.join(home, 'auth.json')), originalAuth);
  } finally {
    resetEnvironment(home);
  }
});

test('failed re-apply recovers the previous applied generation', () => {
  const home = createCodexHome();
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), 'preferred_auth_method = "chatgpt"\n');
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'original-secret' }));
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('first/model'));
    const previousConfig = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const configPath = path.join(home, 'config.toml');
    let failed = false;
    const failingFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            if (!failed && destination === configPath) {
              failed = true;
              const error = new Error('injected re-apply failure');
              error.code = 'EIO';
              throw error;
            }
            return target.renameSync(source, destination);
          };
        }
        return target[property];
      },
    });
    assert.throws(() => new CodexLifecycle({ fileSystem: failingFileSystem }).apply(applyArgs('second/model')), /re-apply failure/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
    assert.equal(readJson(getStatePath()).status, 'applied', JSON.stringify(readJson(getStatePath())));
    lifecycle.reset();
  } finally {
    resetEnvironment(home);
  }
});

test('startup restores a displaced lifecycle state journal after a crash', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('first/model'));
    const state = readJson(getStatePath());
    writeJson(path.join(home, state.recovery.directory, 'state.previous'), state);
    fs.unlinkSync(getStatePath());
    new CodexLifecycle().apply(applyArgs('second/model'));
    assert.equal(readJson(getStatePath()).status, 'applied');
    assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /second\/model/);
    lifecycle.reset();
  } finally {
    resetEnvironment(home);
  }
});

test('malformed state.restore maps fail closed before reset mutation and remain recoverable', () => {
  const variants = [
    { config: false, auth: false, catalog: false },
    { config: false, auth: false, catalog: false, modelsCache: false, extra: false },
    { config: 0, auth: false, catalog: false, modelsCache: false },
    [],
    null,
  ];
  for (const restore of variants) {
    const home = createCodexHome();
    try {
      const lifecycle = new CodexLifecycle();
      lifecycle.apply(applyArgs());
      const validState = fs.readFileSync(getStatePath());
      const appliedFiles = ['config.toml', 'auth.json', 'voidRoute-catalog.json', 'models_cache.json']
        .map((filename) => [filename, fs.readFileSync(path.join(home, filename))]);
      const state = JSON.parse(validState);
      state.restore = restore;
      writeJson(getStatePath(), state);

      assert.throws(() => lifecycle.reset(), /state\.restore is invalid/);
      for (const [filename, data] of appliedFiles) {
        assert.deepEqual(fs.readFileSync(path.join(home, filename)), data, filename);
      }
      assert.equal(readJson(getStatePath()).status, 'applied');

      fs.writeFileSync(getStatePath(), validState);
      assert.deepEqual(lifecycle.reset(), { reset: true, state: null });
    } finally {
      resetEnvironment(home);
    }
  }
});

test('malformed temporary state journal is rejected before adoption mutation', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const state = readJson(getStatePath());
    const journalTemp = path.join(home, state.recovery.directory, 'state.previous.tmp-crash');
    state.restore = { config: false };
    writeJson(journalTemp, state);
    const configBefore = fs.readFileSync(path.join(home, 'config.toml'));
    fs.unlinkSync(getStatePath());

    assert.throws(() => lifecycle.reset(), /state\.restore is invalid/);
    assert.equal(fs.existsSync(getStatePath()), false);
    assert.deepEqual(fs.readFileSync(path.join(home, 'config.toml')), configBefore);
    assert.equal(fs.existsSync(journalTemp), true);
  } finally {
    resetEnvironment(home);
  }
});

test('malformed, empty, and out-of-generation recovery state fails closed', () => {
  const home = createCodexHome();
  try {
    fs.writeFileSync(getStatePath(), '{"status":"applying"}');
    assert.throws(() => new CodexLifecycle().reset(), /state is invalid/);
    fs.unlinkSync(getStatePath());

    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const state = readJson(getStatePath());
    state.recovery.directory = '';
    writeJson(getStatePath(), state);
    assert.throws(() => lifecycle.reset(), /recovery path is malformed/);

    state.recovery.directory = path.relative(home, path.join(home, '.voidRoute-codex-recovery', 'other-generation'));
    writeJson(getStatePath(), state);
    assert.throws(() => lifecycle.reset(), /recovery path is malformed/);
  } finally {
    resetEnvironment(home);
  }
});

test('missing or out-of-generation backup paths are rejected', () => {
  const home = createCodexHome();
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), 'preferred_auth_method = "chatgpt"\n');
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const state = readJson(getStatePath());
    state.original.config.backup = '../config.toml';
    writeJson(getStatePath(), state);
    assert.throws(() => lifecycle.reset(), /backup is outside the allowlist/);

    state.original.config.backup = 'config.backup';
    fs.unlinkSync(path.join(home, state.recovery.directory, 'config.backup'));
    writeJson(getStatePath(), state);
    assert.throws(() => lifecycle.reset(), /Missing Codex recovery backup/);
  } finally {
    resetEnvironment(home);
  }
});

test('lock contention is fail-closed and orphan artifacts are cleaned safely', () => {
  const home = createCodexHome();
  try {
    const lockPath = path.join(home, LOCK_FILENAME);
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
      token: 'held',
    }));
    assert.throws(() => new CodexLifecycle().apply(applyArgs()), /locked by another process/);
    fs.unlinkSync(lockPath);

    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 2147483647,
      hostname: os.hostname(),
      createdAt: '2000-01-01T00:00:00.000Z',
      token: 'stale-dead-owner',
    }));
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    const staleRecoveryLifecycle = new CodexLifecycle();
    staleRecoveryLifecycle.apply(applyArgs('stale-recovered/model'));
    staleRecoveryLifecycle.reset();

    const recovery = path.join(home, '.voidRoute-codex-recovery', 'orphan-generation');
    fs.mkdirSync(recovery, { recursive: true });
    fs.writeFileSync(path.join(recovery, 'config.backup'), 'orphan');
    fs.writeFileSync(path.join(home, 'config.toml.tmp-orphan'), 'orphan');
    fs.writeFileSync(path.join(home, 'auth.json.old-orphan'), 'orphan-secret');
    assert.throws(() => new CodexLifecycle().reset(), /Unowned Codex recovery generation/);
    assert.equal(fs.existsSync(path.join(home, '.voidRoute-codex-recovery')), true);
    assert.equal(fs.existsSync(path.join(recovery, 'config.backup')), true);
    assert.equal(fs.existsSync(path.join(home, 'config.toml.tmp-orphan')), true);
    assert.equal(fs.existsSync(path.join(home, 'auth.json.old-orphan')), true);
  } finally {
    resetEnvironment(home);
  }
});

test('final apply verification rolls back safe files and keeps state when a target drifts', () => {
  const home = createCodexHome();
  try {
    const configPath = path.join(home, 'config.toml');
    const authPath = path.join(home, 'auth.json');
    const originalConfig = 'preferred_auth_method = "chatgpt"\n';
    fs.writeFileSync(configPath, originalConfig);
    fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'original-secret' }));
    let allTargetsWritten = false;
    let drifted = false;
    const driftingFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            if (destination === authPath) allTargetsWritten = true;
            return target.renameSync(source, destination);
          };
        }
        if (property === 'readFileSync') {
          return (file, ...args) => {
            if (allTargetsWritten && file === configPath && !drifted) {
              drifted = true;
              target.writeFileSync(authPath, '{"OPENAI_API_KEY":"external-edit"}\n');
            }
            return target.readFileSync(file, ...args);
          };
        }
        return target[property];
      },
    });

    assert.throws(
      () => new CodexLifecycle({ fileSystem: driftingFileSystem }).apply(applyArgs()),
      /Concurrent edit detected/,
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assert.deepEqual(readJson(authPath), { OPENAI_API_KEY: 'external-edit' });
    assert.equal(readJson(getStatePath()).status, 'applying');
    assert.equal(fs.existsSync(getRecoveryDirectory()), true);
  } finally {
    resetEnvironment(home);
  }
});

test('corrupted recovery backups fail closed before restoring any managed file', () => {
  for (const key of ['config', 'auth', 'modelsCache']) {
    const home = createCodexHome();
    try {
      fs.writeFileSync(path.join(home, 'config.toml'), 'preferred_auth_method = "chatgpt"\n');
      writeJson(path.join(home, 'auth.json'), { OPENAI_API_KEY: 'original-secret' });
      writeJson(path.join(home, 'models_cache.json'), { models: [] });
      const lifecycle = new CodexLifecycle();
      lifecycle.apply(applyArgs());
      const state = readJson(getStatePath());
      const backupPath = path.join(home, state.recovery.directory, `${key === 'modelsCache' ? 'models-cache' : key}.backup`);
      const targetPath = path.join(home, key === 'modelsCache' ? 'models_cache.json' : `${key === 'catalog' ? 'voidRoute-catalog' : key}.${key === 'config' ? 'toml' : 'json'}`);
      const appliedTarget = fs.readFileSync(targetPath);
      fs.writeFileSync(backupPath, Buffer.concat([fs.readFileSync(backupPath), Buffer.from('corrupted')]));

      assert.throws(() => lifecycle.reset(), /backup fingerprint or byte length mismatch/);
      assert.deepEqual(fs.readFileSync(targetPath), appliedTarget);
      assert.equal(fs.existsSync(getStatePath()), true);
    } finally {
      resetEnvironment(home);
    }
  }
});

test('corrupted catalog previous backup fails closed during interrupted re-apply recovery', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('first/model'));
    const catalogPath = getCatalogPath();
    const cachePath = path.join(home, 'models_cache.json');
    const statePath = getStatePath();
    let failed = false;
    let corrupted = false;
    const failingFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            if (!failed && destination === cachePath) {
              failed = true;
              const error = new Error('injected cache write failure');
              error.code = 'EIO';
              throw error;
            }
            return target.renameSync(source, destination);
          };
        }
        if (property === 'readFileSync') {
          return (file, ...args) => {
            const data = target.readFileSync(file, ...args);
            if (failed && file === statePath && !corrupted) {
              corrupted = true;
              const state = JSON.parse(data.toString('utf8'));
              const backup = path.join(home, state.recovery.directory, 'catalog.previous');
              target.writeFileSync(backup, Buffer.concat([target.readFileSync(backup), Buffer.from('corrupted')]));
            }
            return data;
          };
        }
        return target[property];
      },
    });

    assert.throws(
      () => new CodexLifecycle({ fileSystem: failingFileSystem }).apply(applyArgs('second/model')),
      /backup fingerprint or byte length mismatch/,
    );
    assert.equal(readJson(getStatePath()).status, 'applying');
    assert.equal(readJson(catalogPath).models[0].slug, 'second/model');
  } finally {
    resetEnvironment(home);
  }
});

test('recovery cleanup preflights the whole owned generation before deleting artifacts', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const state = readJson(getStatePath());
    const generation = path.join(home, state.recovery.directory);
    const previous = path.join(generation, 'config.previous');
    const ownedTemp = path.join(generation, 'state.previous.tmp-preflight');
    const unknown = path.join(generation, 'unexpected-secret.old');
    fs.writeFileSync(previous, 'previous');
    fs.writeFileSync(ownedTemp, 'owned temp');
    fs.writeFileSync(unknown, 'secret');

    assert.throws(() => lifecycle.apply(applyArgs('next/model')), /Unknown Codex recovery artifact/);
    assert.equal(fs.existsSync(previous), true);
    assert.equal(fs.existsSync(ownedTemp), true);
    assert.equal(fs.existsSync(unknown), true);
  } finally {
    resetEnvironment(home);
  }
});

test('journal and state temporary artifacts recover after an interrupted write', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs('first/model'));
    const state = readJson(getStatePath());
    const journal = path.join(home, state.recovery.directory, 'state.previous');
    let journalFailure = false;
    let strandedJournalTemp = null;
    const failingFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            if (!journalFailure && destination === journal) {
              journalFailure = true;
              const error = new Error('simulated crash during journal write');
              error.code = 'EIO';
              throw error;
            }
            return target.renameSync(source, destination);
          };
        }
        if (property === 'unlinkSync') {
          return (file) => {
            if (journalFailure && String(file).startsWith(`${journal}.tmp-`)) {
              strandedJournalTemp = String(file);
              const error = new Error('simulated process exit before temp cleanup');
              error.code = 'EIO';
              throw error;
            }
            return target.unlinkSync(file);
          };
        }
        return target[property];
      },
    });

    assert.throws(
      () => new CodexLifecycle({ fileSystem: failingFileSystem }).apply(applyArgs('second/model')),
      /simulated crash during journal write/,
    );
    assert.equal(journalFailure, true);
    assert.equal(strandedJournalTemp !== null && fs.existsSync(strandedJournalTemp), true);
    assert.equal(readJson(getStatePath()).status, 'applied');

    const stateTemp = `${getStatePath()}.tmp-simulated-crash`;
    const configTemp = `${path.join(home, 'config.toml')}.tmp-simulated-crash`;
    fs.writeFileSync(stateTemp, 'owned state temp');
    fs.writeFileSync(configTemp, 'owned config temp');
    new CodexLifecycle().apply(applyArgs('second/model'));
    assert.equal(fs.existsSync(strandedJournalTemp), false);
    assert.equal(fs.existsSync(stateTemp), false);
    assert.equal(fs.existsSync(configTemp), false);
    lifecycle.reset();
  } finally {
    resetEnvironment(home);
  }
});

test('a valid state.previous.tmp journal is adopted when state is missing', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const state = readJson(getStatePath());
    const journalTemp = path.join(home, state.recovery.directory, 'state.previous.tmp-crash');
    writeJson(journalTemp, state);
    fs.unlinkSync(getStatePath());

    assert.deepEqual(new CodexLifecycle().reset(), { reset: true, state: null });
    assert.equal(fs.existsSync(getStatePath()), false);
    assert.equal(fs.existsSync(journalTemp), false);
    assert.equal(fs.existsSync(getRecoveryDirectory()), false);
  } finally {
    resetEnvironment(home);
  }
});

test('stale lock replacement is claimed by rename and never unlinks a replacement lock', () => {
  const home = createCodexHome();
  try {
    const lockPath = path.join(home, LOCK_FILENAME);
    const replacement = JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
      token: 'replacement-owner',
    });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 2147483647,
      hostname: os.hostname(),
      createdAt: '2000-01-01T00:00:00.000Z',
      token: 'stale-owner',
    }));
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    let moved = false;
    const racingFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            const result = target.renameSync(source, destination);
            if (source === lockPath && !moved) {
              moved = true;
              target.writeFileSync(lockPath, replacement);
            }
            return result;
          };
        }
        return target[property];
      },
    });

    assert.throws(
      () => new CodexLifecycle({ fileSystem: racingFileSystem }).apply(applyArgs()),
      /lock changed during stale-owner recovery/,
    );
    assert.equal(readJson(lockPath).token, 'replacement-owner');
  } finally {
    resetEnvironment(home);
  }
});

function createSymlinkOrSkip(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

test('symlinked managed files are rejected without following the link', () => {
  const home = createCodexHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'voidroute-codex-outside-'));
  try {
    const outsideConfig = path.join(outside, 'config.toml');
    fs.writeFileSync(outsideConfig, 'outside = true\n');
    if (!createSymlinkOrSkip(outsideConfig, path.join(home, 'config.toml'), 'file')) return;

    assert.throws(() => new CodexLifecycle().apply(applyArgs()), /symlink path/);
    assert.equal(fs.readFileSync(outsideConfig, 'utf8'), 'outside = true\n');
  } finally {
    resetEnvironment(home);
    resetEnvironment(outside);
  }
});

test('symlinked CODEX_HOME ancestors are rejected before directory creation', () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voidroute-codex-real-'));
  const linkedHome = path.join(os.tmpdir(), `voidroute-codex-link-${process.pid}-${Date.now()}`);
  const originalHome = process.env.CODEX_HOME;
  try {
    if (!createSymlinkOrSkip(realHome, linkedHome, 'junction')) return;
    process.env.CODEX_HOME = path.join(linkedHome, 'nested');
    assert.throws(() => new CodexLifecycle().apply(applyArgs()), /symlink path/);
    assert.equal(fs.existsSync(path.join(realHome, 'nested')), false);
  } finally {
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    resetEnvironment(linkedHome);
    resetEnvironment(realHome);
  }
});

test('table comments and multiline root values survive apply and reset', () => {
  const home = createCodexHome();
  const config = [
    'user_root = [',
    '  "one",',
    '  "two",',
    ']',
    '',
    '[projects.example] # user table comment',
    'model = "project-model"',
    'model_provider = "project-provider"',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const applied = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.match(applied, /user_root = \[[\s\S]*"one",[\s\S]*"two",[\s\S]*\]/);
    assert.match(applied, /\[projects\.example\] # user table comment/);
    assert.match(applied, /model = "project-model"/);
    lifecycle.reset();
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
  } finally {
    resetEnvironment(home);
  }
});

test('startup cache refresh requires lifecycle ownership and fingerprints', () => {
  const home = createCodexHome();
  try {
    const catalogPath = getCatalogPath();
    const cachePath = path.join(home, 'models_cache.json');
    writeJson(catalogPath, { models: [{ slug: 'unowned', base_instructions: 'unowned' }] });
    const before = fs.readFileSync(catalogPath);
    assert.throws(() => injectModelsCache(), /without a versioned lifecycle state/);
    assert.deepEqual(fs.readFileSync(catalogPath), before);
    fs.unlinkSync(catalogPath);

    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const cacheBefore = fs.readFileSync(cachePath);
    assert.deepEqual(lifecycle.refreshModelsCache(), { refreshed: true });
    assert.deepEqual(fs.readFileSync(cachePath), cacheBefore);
  } finally {
    resetEnvironment(home);
  }
});

test('recognized legacy backups move to recoverable quarantine before cache refresh', () => {
  const home = createCodexHome();
  try {
    const lifecycle = new CodexLifecycle();
    lifecycle.apply(applyArgs());
    const legacyConfig = {
      rootKeys: 'preferred_auth_method = "chatgpt"\n',
    };
    const legacyModels = [{ slug: 'native-model', base_instructions: 'Native Codex' }];
    const legacyCache = {
      fetched_at: '2026-08-01T00:00:00.000Z',
      client_version: 'legacy',
      models: legacyModels,
    };
    writeJson(path.join(home, 'voidRoute-backup.json'), legacyConfig);
    writeJson(path.join(home, 'voidRoute-models-cache-backup.json'), legacyCache);
    const cacheBefore = fs.readFileSync(path.join(home, 'models_cache.json'));
    fs.unlinkSync(getStatePath());
    fs.rmSync(getRecoveryDirectory(), { recursive: true, force: true });

    assert.deepEqual(lifecycle.refreshModelsCache(), { refreshed: true });
    assert.equal(readJson(getStatePath()).status, 'applied');
    assert.deepEqual(fs.readFileSync(path.join(home, 'models_cache.json')), cacheBefore);
    assert.equal(fs.existsSync(path.join(home, 'voidRoute-backup.json')), false);
    assert.equal(fs.existsSync(path.join(home, 'voidRoute-models-cache-backup.json')), false);

    const quarantineRoot = path.join(home, '.voidRoute-codex-legacy-recovery');
    const generations = fs.readdirSync(quarantineRoot);
    assert.equal(generations.length, 1);
    const quarantine = path.join(quarantineRoot, generations[0]);
    assert.deepEqual(readJson(path.join(quarantine, 'voidRoute-backup.json')), legacyConfig);
    assert.deepEqual(readJson(path.join(quarantine, 'voidRoute-models-cache-backup.json')), legacyCache);
  } finally {
    resetEnvironment(home);
  }
});

test('Windows replacement fallback does not strand old files', () => {
  const home = createCodexHome();
  try {
    // Windows can reject rename-over-existing-file while Codex has the file open;
    // simulate that unavoidable replacement gap and verify journal recovery.
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, 'preferred_auth_method = "chatgpt"\n');
    let simulatedWindowsReplacement = false;
    let unlinkCount = 0;
    const fallbackFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (source, destination) => {
            if (!simulatedWindowsReplacement && destination === configPath) {
              simulatedWindowsReplacement = true;
              const error = new Error('simulated Windows replace restriction');
              error.code = 'EEXIST';
              throw error;
            }
            return target.renameSync(source, destination);
          };
        }
        if (property === 'unlinkSync') {
          return (file) => {
            unlinkCount += 1;
            return target.unlinkSync(file);
          };
        }
        return target[property];
      },
    });
    new CodexLifecycle({ fileSystem: fallbackFileSystem }).apply(applyArgs());
    assert.equal(simulatedWindowsReplacement, true);
    assert.equal(unlinkCount > 0, true);
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.includes('.old-')), []);
    new CodexLifecycle().reset();
  } finally {
    resetEnvironment(home);
  }
});

test('remapRoutedNodePrefixes rewrites custom node ids to short prefixes', () => {
  const nodePrefixById = {
    'openai-compatible-b-ai-6b121aac': 'B.ai',
    'openai-compatible-local-pc-9d74e976': 'local-pc',
  };
  const result = remapRoutedNodePrefixes(
    [
      'openai-compatible-b-ai-6b121aac/minimax-m3',
      'openai-compatible-local-pc-9d74e976/gemma-4',
      'openai/gpt-4o',
      'native-model',
    ],
    nodePrefixById
  );
  assert.deepEqual(result, ['B.ai/minimax-m3', 'local-pc/gemma-4', 'openai/gpt-4o', 'native-model']);
  assert.deepEqual(remapRoutedNodePrefixes(['a/b']), ['a/b']);
  assert.deepEqual(remapRoutedNodePrefixes(['a/b', 'c/d'], {}), ['a/b', 'c/d']);
});

test('TOML escaping removes every ASCII control from generated strings', () => {
  const value = String.fromCodePoint(...Array.from({ length: 32 }, (_, code) => code), 0x7f, 0x80, 0x9f);
  const escaped = escapeTomlString(value);
  for (const character of escaped) {
    assert.equal(character.charCodeAt(0) < 0x20 || (character.charCodeAt(0) >= 0x7f && character.charCodeAt(0) <= 0x9f), false);
  }
  assert.match(escaped, /\\u0000/);
  assert.match(escaped, /\\u007f/);
  assert.match(escaped, /\\u0080/);
  assert.match(escaped, /\\u009f/);
});
