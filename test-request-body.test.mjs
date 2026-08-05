import assert from 'node:assert/strict';
import { test } from 'bun:test';
import {
  DecompressedBodyTooLargeError,
  decodeRequestBody,
  MAX_DECOMPRESSED_BODY_BYTES,
  readJsonRequestBody,
  UnsupportedContentEncodingError,
} from './src/server/request-body.js';

const payload = { model: 'test-model', input: [], stream: true };
const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

test('request body decoder follows Codex compression encodings', async () => {
  const encodings = [
    ['zstd', Bun.zstdCompressSync(payloadBytes)],
    ['gzip', Bun.gzipSync(payloadBytes)],
    ['deflate', Bun.deflateSync(payloadBytes)],
  ];

  for (const [encoding, compressed] of encodings) {
    const request = new Request('http://127.0.0.1/v1/responses', {
      method: 'POST',
      headers: { 'Content-Encoding': encoding, 'Content-Type': 'application/json' },
      body: compressed,
    });
    assert.deepEqual(await readJsonRequestBody(request), payload, `${encoding} should parse`);
  }
});

test('request body decoder rejects unsupported and malformed compressed input', async () => {
  assert.throws(
    () => decodeRequestBody(payloadBytes, 'br'),
    UnsupportedContentEncodingError,
  );

  const request = new Request('http://127.0.0.1/v1/responses', {
    method: 'POST',
    headers: { 'Content-Encoding': 'zstd', 'Content-Type': 'application/json' },
    body: Bun.zstdCompressSync(new TextEncoder().encode('{"model":')),
  });
  await assert.rejects(readJsonRequestBody(request), SyntaxError);
});

test('request body decoder enforces the decompressed output cap during inflation', () => {
  const cap = 1024;
  const oversized = new Uint8Array(cap * 64);

  for (const [encoding, compressed] of [
    ['zstd', Bun.zstdCompressSync(oversized)],
    ['gzip', Bun.gzipSync(oversized)],
    ['deflate', Bun.deflateSync(oversized)],
  ]) {
    assert.throws(
      () => decodeRequestBody(compressed, encoding, cap),
      DecompressedBodyTooLargeError,
    );
  }

  assert.equal(MAX_DECOMPRESSED_BODY_BYTES, 256 * 1024 * 1024);
  assert.throws(() => decodeRequestBody(new Uint8Array(cap + 1), null, cap), DecompressedBodyTooLargeError);
});
