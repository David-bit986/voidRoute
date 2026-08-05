import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { buildModelList, getModels } from './src/server/model-list.js';

test('model list advertises active chat-capable models', async () => {
  const connections = [
    { provider: 'runwayml', isActive: true },
    { provider: 'openai', isActive: false },
  ];
  const modelsByProvider = {
    runwayml: [
      { id: 'gen4_image', type: 'image' },
      { id: 'gen4_turbo', type: 'video' },
      { id: 'runway-chat', type: 'llm' },
    ],
    openai: [
      { id: 'gpt-4o', type: 'llm' },
    ],
  };

  const modelList = buildModelList(connections, (provider) => modelsByProvider[provider]);
  assert.deepEqual(modelList.data.map((model) => model.id), ['runwayml/runway-chat']);

  let requestedFilter;
  const queriedList = await getModels({
    getConnections: async (filter) => {
      requestedFilter = filter;
      return connections;
    },
    getProviderModels: (provider) => modelsByProvider[provider],
  });
  assert.deepEqual(requestedFilter, { isActive: true });
  assert.deepEqual(queriedList.data.map((model) => model.id), ['runwayml/runway-chat']);

  console.log('model list regression: active connections only and video-only models filtered');
});

test('Codex client_version requests receive the Codex catalog shape', async () => {
  const models = [
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
    { slug: 'ag/claude-opus-4-6-thinking', display_name: 'ag/claude-opus-4-6-thinking', visibility: 'list' },
  ];

  const response = await getModels({
    request: new Request('http://127.0.0.1:20130/v1/models?client_version=0.146.0'),
    getCodexCatalog: () => ({ models }),
  });

  assert.deepEqual(response, { models });
});

test('custom node providers advertise models with the short node prefix', async () => {
  const connections = [
    { provider: 'openai-compatible-b-ai-6b121aac', isActive: true },
    { provider: 'openai', isActive: true },
  ];
  const modelsByProvider = {
    'openai-compatible-b-ai-6b121aac': [{ id: 'minimax-m3', type: 'llm' }],
    openai: [{ id: 'gpt-4o', type: 'llm' }],
  };
  const prefixById = { 'openai-compatible-b-ai-6b121aac': 'b.ai' };

  const modelList = buildModelList(
    connections,
    (provider) => modelsByProvider[provider],
    prefixById
  );
  assert.deepEqual(modelList.data.map((model) => model.id), ['b.ai/minimax-m3', 'openai/gpt-4o']);

  const queried = await getModels({
    getConnections: async () => connections,
    getProviderModels: (provider) => modelsByProvider[provider],
    getProviderNodes: async () => [
      { id: 'openai-compatible-b-ai-6b121aac', name: 'B.ai', prefix: 'b.ai' },
    ],
  });
  assert.deepEqual(queried.data.map((model) => model.id), ['b.ai/minimax-m3', 'openai/gpt-4o']);

  console.log('model list regression: custom nodes resolved via node prefix');
});
