#!/usr/bin/env node
/**
 * Dynamic model fetcher — queries any provider's /models endpoint.
 * Usage:
 *   bun run fetch-models.mjs                           # fetch all configured providers
 *   bun run fetch-models.mjs --provider deepseek       # fetch a specific provider
 *   bun run fetch-models.mjs --url https://api.deepseek.com/models --key sk-xxx  # custom
 *   bun run fetch-models.mjs --list-providers          # list known provider URLs
 */

import { PROVIDERS } from './open-sse/config/providers.js';
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from './open-sse/config/providerModels.js';
import chalk from 'chalk';

// ─── Hardcoded model endpoints for well-known providers ──────────────────────
const KNOWN_ENDPOINTS = {
  openai:         'https://api.openai.com/v1/models',
  openrouter:     'https://openrouter.ai/api/v1/models',
  deepseek:       'https://api.deepseek.com/models',
  siliconflow:    'https://api.siliconflow.cn/v1/models',
  groq:           'https://api.groq.com/openai/v1/models',
  together:       'https://api.together.xyz/v1/models',
  gemini:         'https://generativelanguage.googleapis.com/v1beta/models',
  anthropic:      'https://api.anthropic.com/v1/models',
  ollama:         'http://localhost:11434/api/tags',
  mistral:        'https://api.mistral.ai/v1/models',
  xai:            'https://api.x.ai/v1/models',
  perplexity:     'https://api.perplexity.ai/models',
  cerebras:       'https://api.cerebras.ai/v1/models',
  cohere:         'https://api.cohere.com/v1/models',
  nvidia:         'https://integrate.api.nvidia.com/v1/models',
  nebius:         'https://api.studio.nebius.ai/v1/models',
  hyperbolic:     'https://api.hyperbolic.xyz/v1/models',
  deepinfra:      'https://api.deepinfra.com/v1/openai/models',
  sambanova:      'https://api.sambanova.ai/v1/models',
};

function buildUrlFromBase(providerId) {
  const def = PROVIDERS[providerId];
  if (!def?.baseUrl) return null;

  let base = def.baseUrl;
  if (base.endsWith('/chat/completions')) base = base.replace(/\/chat\/completions$/, '');
  else if (base.endsWith('/messages')) base = base.replace(/\/messages$/, '');

  if (base.endsWith('/v1')) return `${base}/models`;
  if (base.includes('/v1/')) return base.split('/v1/')[0] + '/v1/models';
  return `${base}/models`;
}

function getUrl(providerId) {
  return KNOWN_ENDPOINTS[providerId] || buildUrlFromBase(providerId);
}

function getAuthHeaders(providerId, apiKey) {
  const h = { 'Accept': 'application/json' };
  if (!apiKey) return h;

  if (providerId === 'anthropic') {
    h['x-api-key'] = apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else if (providerId === 'gemini') {
    h['x-goog-api-key'] = apiKey;
  } else {
    h['Authorization'] = `Bearer ${apiKey}`;
  }
  return h;
}

function parseResponse(providerId, data) {
  if (providerId === 'ollama') {
    return (data?.models || []).map(m => ({ id: m.name, name: m.name }));
  }
  if (providerId === 'gemini') {
    return (data?.models || [])
      .filter(m => m.name?.startsWith('models/'))
      .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
  }
  if (Array.isArray(data?.data)) {
    return data.data.map(m => ({ id: m.id, name: m.id }));
  }
  if (Array.isArray(data)) {
    return data.map(m => typeof m === 'string' ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id });
  }
  return [];
}

async function fetchModels(providerId, apiKey) {
  const url = getUrl(providerId);
  if (!url) return null;

  const headers = getAuthHeaders(providerId, apiKey);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return parseResponse(providerId, await res.json());
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const listFlag = args.includes('--list-providers') || args.includes('-l');
const urlFlagIdx = args.indexOf('--url');
const keyFlagIdx = args.indexOf('--key');
const providerFlagIdx = args.indexOf('--provider');

if (listFlag) {
  console.log(chalk.cyan('\n  Known provider model endpoints:\n'));
  for (const [provider, url] of Object.entries(KNOWN_ENDPOINTS)) {
    console.log(`  ${chalk.white.bold(provider.padEnd(18))} ${chalk.gray(url)}`);
  }
  console.log(chalk.dim('\n  Other providers use auto-constructed URL from baseUrl\n'));
  process.exit(0);
}

if (urlFlagIdx !== -1) {
  const url = args[urlFlagIdx + 1];
  const apiKey = keyFlagIdx !== -1 ? args[keyFlagIdx + 1] : null;
  if (!url) { console.error(chalk.red('Missing URL after --url')); process.exit(1); }

  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  console.log(chalk.cyan(`\n  Fetching: ${url}`));
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) { console.error(chalk.red(`  HTTP ${res.status}: ${res.statusText}`)); process.exit(1); }

  const data = await res.json();
  const models = parseResponse('generic', data);
  console.log(chalk.green(`\n  ${models.length} models found:\n`));
  for (const m of models) {
    console.log(`  ${chalk.gray('•')} ${chalk.white(m.id)}${m.name && m.name !== m.id ? chalk.dim(` — ${m.name}`) : ''}`);
  }
  console.log('');
  process.exit(0);
}

if (providerFlagIdx !== -1) {
  const provider = args[providerFlagIdx + 1];
  const apiKey = keyFlagIdx !== -1 ? args[keyFlagIdx + 1] : process.env[`${provider.toUpperCase()}_API_KEY`];
  if (!provider) { console.error(chalk.red('Missing provider after --provider')); process.exit(1); }

  console.log(chalk.cyan(`\n  Fetching ${provider} models...`));
  const models = await fetchModels(provider, apiKey);
  if (!models) { console.error(chalk.red(`\n  Failed to fetch models for ${provider}\n  API key may be required or endpoint unreachable\n`)); process.exit(1); }

  console.log(chalk.green(`\n  ${models.length} models found for ${provider}:\n`));
  for (const m of models) {
    console.log(`  ${chalk.gray('•')} ${chalk.white(m.id)}${m.name && m.name !== m.id ? chalk.dim(` — ${m.name}`) : ''}`);
  }
  console.log('');
  process.exit(0);
}

// Default: list all providers with their model endpoints + static count
console.log(chalk.cyan('\n  Provider Model Endpoints Reference\n'));
console.log(chalk.gray('  Run with --provider <name> --key <api_key> to fetch live models\n'));

for (const [provider, url] of Object.entries(KNOWN_ENDPOINTS)) {
  const alias = PROVIDER_ID_TO_ALIAS[provider];
  const staticCount = (PROVIDER_MODELS[alias] || PROVIDER_MODELS[provider])?.length || 0;
  console.log(`  ${chalk.white.bold(provider.padEnd(18))} ${chalk.gray(url)}  ${staticCount > 0 ? chalk.dim(`[${staticCount} static]`) : ''}`);
}

console.log(chalk.dim('\n  To fetch live models: bun run fetch-models.mjs --provider deepseek --key sk-xxx\n'));
