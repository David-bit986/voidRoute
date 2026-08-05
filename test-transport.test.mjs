import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  createNativeRequestHandler,
  MAX_REQUEST_BODY_SIZE,
  startNativeServer,
} from './src/server/transport.js';

const calls = [];
const routeCalls = [];
let modelsCalls = 0;

const noOpHandlers = Object.fromEntries([
  ['embeddings', { route: 'embeddings' }],
  ['fetch', { route: 'fetch' }],
  ['search', { route: 'search' }],
  ['imageGeneration', { route: 'imageGeneration' }],
  ['tts', { route: 'tts' }],
  ['stt', { route: 'stt' }],
].map(([name, body]) => [name, async () => {
  routeCalls.push(name);
  return Response.json(body);
}]));

const fetchHandler = createNativeRequestHandler({
  getModels: async () => {
    modelsCalls += 1;
    return { object: 'list', data: [] };
  },
  handleChat: async (request, rawRequest) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const sameBody = await request.json();
    assert.strictEqual(sameBody, body);
    assert.strictEqual(rawRequest.body, body);
    calls.push({ path: new URL(request.url).pathname, rawRequest });

    if (body.throw) {
      throw new Error('secret handler implementation detail');
    }

    if (body.stream) {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), {
        headers: {
          'Content-Type': 'text/event-stream',
          'X-Passthrough': 'preserved',
        },
      });
    }

    return new Response(JSON.stringify({ routed: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
  handlers: {
    ...noOpHandlers,
    stt: async (request) => {
      routeCalls.push('stt');
      const formData = await request.formData();
      const file = formData.get('file');
      return Response.json({
        model: formData.get('model'),
        filename: file.name,
        contents: await file.text(),
      });
    },
  },
});

const timeoutCalls = [];
const timeoutProbeHandler = createNativeRequestHandler({
  getModels: async () => ({ object: 'list', data: [] }),
  handleChat: async (request) => {
    await request.json();
    return new Response('ok');
  },
  handlers: noOpHandlers,
});
const timeoutProbeResponse = await timeoutProbeHandler(
  new Request('http://127.0.0.1/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', input: [] }),
  }),
  {
    timeout(request, seconds) {
      timeoutCalls.push({ request, seconds });
    },
  },
);
assert.equal(timeoutProbeResponse.status, 200);
assert.equal(timeoutCalls.length, 1);
assert.equal(timeoutCalls[0].seconds, 0);

const boundedBodyHandler = createNativeRequestHandler({
  getModels: async () => ({ object: 'list', data: [] }),
  handleChat: async () => {
    throw new Error('oversized body should be rejected before the handler');
  },
  handlers: noOpHandlers,
  maxDecompressedBodyBytes: 1024,
});
const oversizedCompressedResponse = await boundedBodyHandler(new Request('http://127.0.0.1/v1/responses', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'zstd' },
  body: Bun.zstdCompressSync(new Uint8Array(64 * 1024)),
}));
assert.equal(oversizedCompressedResponse.status, 413);
assert.deepEqual(await oversizedCompressedResponse.json(), {
  error: {
    message: 'Decompressed request body exceeds 1024 bytes',
    type: 'invalid_request_error',
    code: 'request_body_too_large',
  },
});

test('transport regression', async () => {
  const server = startNativeServer({ port: 0, fetch: fetchHandler });
  assert.equal(server.hostname, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${server.port}`;

  try {
  const upgradeResponse = await fetch(`${baseUrl}/v1/responses`, {
    headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
  });
  assert.equal(upgradeResponse.status, 426);
  assert.equal(upgradeResponse.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await upgradeResponse.json(), {
    error: {
      message: 'Responses WebSocket transport is disabled; use HTTP',
      type: 'upgrade_required',
      code: 'upgrade_required',
    },
  });
  assert.equal(calls.length, 0);

  const normalResponse = await fetch(`${baseUrl}/v1/responses/?trace=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', input: [] }),
  });
  assert.equal(normalResponse.status, 200);
  assert.deepEqual(await normalResponse.json(), { routed: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v1/responses/');
  assert.equal(calls[0].rawRequest.endpoint, '/v1/responses/?trace=1');
  assert.deepEqual(calls[0].rawRequest.body, { model: 'test-model', input: [] });
  assert.equal(calls[0].rawRequest.headers['content-type'], 'application/json');

  const compressedPayload = JSON.stringify({ model: 'test-model', input: [] });
  for (const [encoding, body] of [
    ['zstd', Bun.zstdCompressSync(new TextEncoder().encode(compressedPayload))],
    ['gzip', Bun.gzipSync(new TextEncoder().encode(compressedPayload))],
    ['deflate', Bun.deflateSync(new TextEncoder().encode(compressedPayload))],
  ]) {
    const compressedResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding },
      body,
    });
    assert.equal(compressedResponse.status, 200, `${encoding} request should parse`);
    assert.deepEqual(await compressedResponse.json(), { routed: true });
  }

  const malformedResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"model":',
  });
  assert.equal(malformedResponse.status, 400);
  assert.deepEqual(await malformedResponse.json(), {
    error: {
      message: 'Invalid JSON body',
      type: 'invalid_request_error',
      code: 'invalid_request_error',
    },
  });

  const unsupportedEncodingResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
    body: JSON.stringify({ model: 'test-model', input: [] }),
  });
  assert.equal(unsupportedEncodingResponse.status, 415);
  assert.deepEqual(await unsupportedEncodingResponse.json(), {
    error: {
      message: 'Unsupported content-encoding: br',
      type: 'invalid_request_error',
      code: 'unsupported_content_encoding',
    },
  });

  const embeddingsResponse = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'embedding-model', input: ['hello'] }),
  });
  assert.equal(embeddingsResponse.status, 200);
  assert.deepEqual(await embeddingsResponse.json(), { route: 'embeddings' });
  assert.equal(routeCalls.includes('embeddings'), true);

  const modelsResponse = await fetch(`${baseUrl}/v1/models/`);
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(await modelsResponse.json(), { object: 'list', data: [] });

  const headResponse = await fetch(`${baseUrl}/v1/models/`, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), '');
  assert.equal(modelsCalls, 2);

  const preflightResponse = await fetch(`${baseUrl}/v1/responses/`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflightResponse.status, 204);
  assert.equal(preflightResponse.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(preflightResponse.headers.get('access-control-allow-methods'), 'GET,HEAD,PUT,PATCH,POST,DELETE');
  assert.equal(preflightResponse.headers.get('access-control-allow-headers'), 'authorization,content-type');

  const rejectedOriginResponse = await fetch(`${baseUrl}/v1/models`, {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(rejectedOriginResponse.status, 403);
  assert.equal(rejectedOriginResponse.headers.get('access-control-allow-origin'), null);

  const streamResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', input: [], stream: true }),
  });
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get('x-passthrough'), 'preserved');
  assert.equal(await streamResponse.text(), 'data: first\n\ndata: [DONE]\n\n');

  const multipartBody = new FormData();
  multipartBody.append('model', 'test-model');
  multipartBody.append('file', new Blob(['hello multipart']), 'prompt.txt');
  const multipartResponse = await fetch(`${baseUrl}/v1/audio/transcriptions/`, {
    method: 'POST',
    body: multipartBody,
  });
  assert.equal(multipartResponse.status, 200);
  assert.deepEqual(await multipartResponse.json(), {
    model: 'test-model',
    filename: 'prompt.txt',
    contents: 'hello multipart',
  });

  const thrownResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', throw: true }),
  });
  assert.equal(thrownResponse.status, 500);
  const thrownBody = await thrownResponse.json();
  assert.deepEqual(thrownBody, {
    error: {
      message: 'Internal server error',
      type: 'server_error',
      code: 'internal_server_error',
    },
  });
  assert.equal(JSON.stringify(thrownBody).includes('secret handler implementation detail'), false);

  let oversizedRequestRejected = false;
  try {
    const oversizedResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(MAX_REQUEST_BODY_SIZE + 1),
    });
    oversizedRequestRejected = oversizedResponse.status === 413;
  } catch (error) {
    // Bun 1.3.14 closes an over-limit connection instead of returning 413.
    oversizedRequestRejected = error?.code === 'ECONNRESET';
  }
  assert.equal(oversizedRequestRejected, true);
   assert.equal(calls.length, 6);
  } finally {
    await server.stop(true);
  }

  const remoteFetchHandler = createNativeRequestHandler({
    hostname: '0.0.0.0',
    authToken: 'transport-test-token',
    getModels: async () => ({ object: 'list', data: [] }),
    handleChat: async () => Response.json({ routed: true }),
    handlers: noOpHandlers,
  });

  const missingAuthResponse = await remoteFetchHandler(new Request('http://0.0.0.0/v1/models'));
  assert.equal(missingAuthResponse.status, 401);
  const authenticatedResponse = await remoteFetchHandler(new Request('http://0.0.0.0/v1/models', {
    headers: { 'x-opencodex-api-key': 'transport-test-token' },
  }));
  assert.equal(authenticatedResponse.status, 200);
  assert.throws(
    () => startNativeServer({ port: 0, hostname: '0.0.0.0', fetch: fetchHandler }),
    /OPENCODEX_API_AUTH_TOKEN is required/,
  );

  console.log('transport regression: auth, CORS, routes, malformed JSON, body limit, streaming, multipart, and errors passed');
});
