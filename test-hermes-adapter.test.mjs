import assert from 'node:assert/strict';
import { afterEach, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesAdapter, renderHermesConfig, stripHermesConfig } from './src/lib/cli-config/HermesAdapter.js';

let tempHome = null;

function makeHome() {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voidroute-hermes-'));
  return tempHome;
}

afterEach(() => {
  if (tempHome) {
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    tempHome = null;
  }
});

test('renderHermesConfig writes providers.voidroute and model block on empty config', () => {
  const out = renderHermesConfig('', {
    endpoint: 'http://localhost:20130/v1',
    defaultModel: 'b.ai/minimax-m3',
    models: ['b.ai/minimax-m3', 'b.ai/glm-5.1'],
  });
  assert.match(out, /providers:/);
  assert.match(out, /voidroute:/);
  assert.match(out, /api: 'http:\/\/localhost:20130\/v1'/);
  assert.match(out, /models:/);
  assert.match(out, /- 'b\.ai\/minimax-m3'/);
  assert.match(out, /- 'b\.ai\/glm-5\.1'/);
  assert.match(out, /model:/);
  assert.match(out, /default: 'b\.ai\/minimax-m3'/);
  assert.match(out, /provider: 'custom:voidroute'/);
});

test('renderHermesConfig preserves unrelated sections and keys', () => {
  const existing = [
    'terminal:',
    '  backend: docker',
    '  timeout: 300',
    '',
    'auxiliary:',
    '  vision:',
    "    provider: 'auto'",
    '',
    'model:',
    "  default: 'some-old-model'",
    "  provider: 'openrouter'",
    "  base_url: 'https://stale.example.com/v1'",
    "  api_key: 'stale'",
    '  supports_vision: true',
    '',
    'providers:',
    '  openrouter:',
    "    api: 'https://openrouter.ai/api/v1'",
    '    key_env: OPENROUTER_API_KEY',
    '  voidroute:',
    "    api: 'http://old-lan-host:9000/v1'",
    '',
  ].join('\n');

  const out = renderHermesConfig(existing, {
    endpoint: 'http://localhost:20130/v1',
    defaultModel: 'b.ai/minimax-m3',
    models: ['b.ai/minimax-m3'],
  });

  // Untouched sections preserved
  assert.match(out, /terminal:\n {2}backend: docker/);
  assert.match(out, /auxiliary:\n {2}vision:/);
  // model block: owned keys replaced, foreign key kept
  assert.match(out, /model:\n {2}default: 'b\.ai\/minimax-m3'\n {2}provider: 'custom:voidroute'\n {2}supports_vision: true/);
  assert.ok(!out.includes('some-old-model'));
  assert.ok(!out.includes('https://stale.example.com/v1'));
  // providers block: old voidroute replaced, openrouter untouched
  assert.match(out, /openrouter:\n {4}api: 'https:\/\/openrouter\.ai\/api\/v1'/);
  assert.ok(!out.includes('old-lan-host'));
  assert.match(out, /voidroute:\n {4}api: 'http:\/\/localhost:20130\/v1'/);
});

test('stripHermesConfig removes owned blocks but leaves model intact when provider differs', () => {
  const config = renderHermesConfig([
    'terminal:',
    '  backend: local',
    '',
  ].join('\n'), {
    endpoint: 'http://localhost:20130/v1',
    defaultModel: 'b.ai/minimax-m3',
    models: ['b.ai/minimax-m3', 'b.ai/kimi-k2.5'],
  });

  const stripped = stripHermesConfig(config);
  assert.ok(!stripped.includes('voidroute'));
  assert.match(stripped, /terminal:\n {2}backend: local/);
  // model block: owned keys removed (default/provider) but structure kept
  assert.match(stripped, /model:/);
  assert.ok(!stripped.includes('b.ai/minimax-m3'));
  assert.ok(!stripped.includes('custom:voidroute'));
});

test('stripHermesConfig keeps model block when someone switched away from voidRoute', () => {
  const config = [
    'model:',
    "  default: 'qwen3-coder-plus'",
    "  provider: 'alibaba'",
    '',
    'providers:',
    '  voidroute:',
    "    api: 'http://localhost:20130/v1'",
    '    models:',
    "      - 'b.ai/minimax-m3'",
    '  alibaba:',
    '    key_env: DASHSCOPE_API_KEY',
  ].join('\n');

  const out = stripHermesConfig(config);
  assert.ok(!out.includes('voidroute'));
  assert.match(out, /default: 'qwen3-coder-plus'/);
  assert.match(out, /provider: 'alibaba'/);
  assert.match(out, /alibaba:/);
});

test('HermesAdapter apply/detect/reset roundtrip on a temp home', () => {
  const home = makeHome();
  const adapter = new HermesAdapter({ home });
  assert.equal(adapter.detectStatus(), null);

  const result = adapter.applyConfig(
    'b.ai/minimax-m3',
    'http://localhost:20130/v1',
    'http://localhost:20130',
    [{ id: 'b.ai/minimax-m3', name: 'x' }, { id: 'b.ai/glm-5.1', name: 'y' }],
    ['b.ai/minimax-m3', 'b.ai/glm-5.1'],
    'b.ai/minimax-m3'
  );
  assert.equal(result.applied, true);
  assert.equal(adapter.detectStatus(), 'connected');
  const file = adapter.configPath();
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /voidroute:/);
  assert.match(raw, /default: 'b\.ai\/minimax-m3'/);
  assert.match(raw, /provider: 'custom:voidroute'/);

  const reset = adapter.resetConfig();
  assert.equal(reset.reset, true);
  assert.equal(adapter.detectStatus(), null);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.includes('voidroute'));
});