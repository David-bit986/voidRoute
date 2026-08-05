import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  maskSensitiveHeaders,
  redactSensitiveData,
  REDACTED_SECRET,
} from './open-sse/utils/requestLogger.js';
import { buildRequestDetail } from './open-sse/handlers/chatCore/requestDetail.js';
import { prepareUsageEntryForStorage } from './src/lib/db/repos/usageWrite.js';

const secrets = {
  authorization: 'Bearer authorization-secret',
  apiKey: 'api-key-secret',
  transportKey: 'transport-key-secret',
  cookie: 'session=session-secret',
  token: 'token-secret',
};

test('request logger masks all transport and provider credentials', () => {
  const headers = maskSensitiveHeaders({
    Authorization: secrets.authorization,
    'x-api-key': secrets.apiKey,
    'x-opencodex-api-key': secrets.transportKey,
    Cookie: secrets.cookie,
    token: secrets.token,
    'content-type': 'application/json',
  });

  assert.equal(headers.authorization, REDACTED_SECRET);
  assert.equal(headers['x-api-key'], REDACTED_SECRET);
  assert.equal(headers['x-opencodex-api-key'], REDACTED_SECRET);
  assert.equal(headers.cookie, REDACTED_SECRET);
  assert.equal(headers.token, REDACTED_SECRET);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(JSON.stringify(headers).includes('secret'), false);
});

test('request log payloads and request details redact nested secret fields', () => {
  const detail = buildRequestDetail({
    provider: 'test-provider',
    model: 'test-model',
    request: {
      headers: {
        Authorization: secrets.authorization,
        'x-opencodex-api-key': secrets.transportKey,
      },
      token: secrets.token,
      prompt_tokens: 3,
    },
    providerRequest: { headers: { Cookie: secrets.cookie }, apiKey: secrets.apiKey },
    response: { text: `Bearer ${secrets.token}` },
  });

  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(detail.request.prompt_tokens, 3);
  assert.equal(detail.request.token, REDACTED_SECRET);
  assert.equal(detail.providerRequest.apiKey, REDACTED_SECRET);
  assert.equal(redactSensitiveData({ token: secrets.token }).token, REDACTED_SECRET);
});

test('usage persistence seam drops raw API keys and token values', () => {
  const prepared = prepareUsageEntryForStorage({
    provider: 'test-provider',
    model: 'test-model',
    apiKey: secrets.apiKey,
    tokens: {
      prompt_tokens: 4,
      completion_tokens: 2,
      token: secrets.token,
    },
  });

  assert.equal(prepared.apiKey, null);
  assert.equal(prepared.tokens.prompt_tokens, 4);
  assert.equal(prepared.tokens.token, REDACTED_SECRET);
  assert.equal(JSON.stringify(prepared).includes('secret'), false);
});
