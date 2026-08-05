import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  classifyModel,
  formatModelReference,
  hasModelCapability,
  isChatModel,
  parseModelReference,
} from './src/shared/constants/modelIdentity.js';
import { parseModel, resolveModelAliasFromMap } from './open-sse/services/model.js';
import { buildModelList } from './src/server/model-list.js';
import { buildCatalog } from './src/lib/cli-config/CodexCatalog.js';

test('model references resolve provider aliases and preserve nested model IDs', () => {
  const parsed = parseModelReference('cx/anthropic/gpt-5.4');

  assert.deepEqual(parsed, {
    provider: 'codex',
    model: 'anthropic/gpt-5.4',
    isAlias: false,
    providerAlias: 'cx',
  });
  assert.equal(formatModelReference(parsed), 'cx/anthropic/gpt-5.4');
  assert.equal(formatModelReference({ provider: 'codex', model: 'gpt-5.4' }), 'cx/gpt-5.4');
  assert.equal(formatModelReference(parseModelReference('codex/gpt-5.4'), { preserveInputAlias: false }), 'cx/gpt-5.4');
  assert.deepEqual(parseModel('kc/anthropic/claude-sonnet-4'), {
    provider: 'kilocode',
    model: 'anthropic/claude-sonnet-4',
    isAlias: false,
    providerAlias: 'kc',
  });
});

test('model aliases resolve with the same first-slash and nested-ID rules', () => {
  assert.deepEqual(resolveModelAliasFromMap('review', {
    review: 'cx/openai/gpt-5.4',
  }), {
    provider: 'codex',
    model: 'openai/gpt-5.4',
  });
});

test('model identity classifies chat and non-chat capabilities', () => {
  assert.equal(isChatModel('gpt-5.4'), true);
  assert.equal(isChatModel({ id: 'image', type: 'image' }), false);
  assert.equal(isChatModel({ id: 'embedding', type: ['embedding'] }), false);
  assert.equal(isChatModel({ id: 'speech', capabilities: ['tts'] }), false);
  assert.equal(isChatModel({ id: 'vision-chat', type: 'llm', capabilities: ['image'] }), true);
  assert.equal(hasModelCapability({ type: 'image', capabilities: ['text2img'] }, 'image'), true);
  assert.deepEqual(classifyModel({ type: 'llm' }), {
    type: 'llm',
    types: ['llm'],
    capabilities: ['llm', 'chat'],
    isChat: true,
    isNonChat: false,
  });
});

test('model lists use provider aliases, active connections, nested IDs, and chat filtering', () => {
  const connections = [
    { provider: 'codex', isActive: true },
    { provider: 'claude', isActive: false },
  ];
  const modelsByProvider = {
    codex: [
      { id: 'gpt-5.4' },
      { id: 'openai/gpt-5.4-mini' },
      { id: 'image-model', type: 'image' },
      { id: 'embedding-model', type: 'embedding' },
    ],
    claude: [{ id: 'claude-sonnet-4' }],
  };

  assert.deepEqual(buildModelList(connections, (provider) => modelsByProvider[provider]).data.map((model) => model.id), [
    'cx/gpt-5.4',
    'cx/openai/gpt-5.4-mini',
  ]);
});

test('Codex catalog projection keeps model reference slugs intact', () => {
  const catalog = buildCatalog(['cx/openai/gpt-5.4', 'cx/openai/gpt-5.4']);
  assert.deepEqual(catalog.models.filter((model) => model.slug === 'cx/openai/gpt-5.4').map((model) => model.slug), [
    'cx/openai/gpt-5.4',
  ]);
});
