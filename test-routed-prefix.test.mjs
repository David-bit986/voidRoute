import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { isCustomNodeProvider, resolveRoutedPrefix } from './src/sse/utils/routedPrefix.js';

const NODES = [
  { id: 'openai-compatible-b-ai-6b121aac', name: 'B.ai', prefix: 'B.ai' },
  { id: 'openai-compatible-local-pc-9d74e976', name: 'local-pc', prefix: 'local-pc' },
  { id: 'custom-embedding-text-embed-3f1a', name: 'embeddings', prefix: 'embeddings' },
];

test('isCustomNodeProvider recognises custom node provider ids only', () => {
  assert.equal(isCustomNodeProvider('openai-compatible-b-ai-6b121aac'), true);
  assert.equal(isCustomNodeProvider('anthropic-compatible-anything'), true);
  assert.equal(isCustomNodeProvider('custom-embedding-text-embed'), true);
  assert.equal(isCustomNodeProvider('openai'), false);
  assert.equal(isCustomNodeProvider('ag'), false);
});

test('resolveRoutedPrefix returns the node short prefix for custom nodes', async () => {
  assert.equal(await resolveRoutedPrefix('openai-compatible-b-ai-6b121aac', NODES), 'B.ai');
  assert.equal(await resolveRoutedPrefix('custom-embedding-text-embed-3f1a', NODES), 'embeddings');
  assert.equal(await resolveRoutedPrefix('unknown-node', NODES), null);
  assert.equal(await resolveRoutedPrefix('openai', NODES), null);
  assert.equal(await resolveRoutedPrefix('ag', NODES), null);
});