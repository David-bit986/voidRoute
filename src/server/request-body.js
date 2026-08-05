import {
  gunzipSync,
  inflateRawSync,
  inflateSync,
  zstdDecompressSync,
} from 'node:zlib';

export const MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024 * 1024;

export class UnsupportedContentEncodingError extends Error {
  constructor(encoding) {
    super(`Unsupported content-encoding: ${encoding}`);
    this.name = 'UnsupportedContentEncodingError';
    this.encoding = encoding;
  }
}

export class DecompressedBodyTooLargeError extends Error {
  constructor(bytes, limit = MAX_DECOMPRESSED_BODY_BYTES) {
    super(`Decompressed request body exceeds ${limit} bytes`);
    this.name = 'DecompressedBodyTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

function assertBodySizeWithinLimit(body, maxBytes) {
  if (body.byteLength > maxBytes) throw new DecompressedBodyTooLargeError(body.byteLength, maxBytes);
  return body;
}

function declaredBodyLength(request) {
  const raw = request.headers.get('content-length');
  if (raw === null || raw.trim() === '') return null;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

function inflateDeflateBody(compressed, options) {
  // HTTP deflate is seen both zlib-wrapped and raw. Match opencodex's fallback,
  // but do not turn a zlib size-cap abort into a second inflate attempt.
  try {
    return inflateSync(compressed, options);
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw error;
    return inflateRawSync(compressed, options);
  }
}

export function decodeRequestBody(raw, contentEncoding, maxBytes = MAX_DECOMPRESSED_BODY_BYTES) {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return assertBodySizeWithinLimit(raw, maxBytes);

  const options = { maxOutputLength: maxBytes };
  let decoded;
  try {
    if (encoding === 'zstd') decoded = zstdDecompressSync(raw, options);
    else if (encoding === 'gzip' || encoding === 'x-gzip') decoded = gunzipSync(raw, options);
    else if (encoding === 'deflate') decoded = inflateDeflateBody(raw, options);
    else throw new UnsupportedContentEncodingError(encoding);
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DecompressedBodyTooLargeError(maxBytes + 1, maxBytes);
    }
    throw error;
  }
  return assertBodySizeWithinLimit(decoded, maxBytes);
}

export async function readBoundedJsonRequestBody(
  request,
  maxBytes = MAX_DECOMPRESSED_BODY_BYTES,
) {
  const declaredLength = declaredBodyLength(request);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new DecompressedBodyTooLargeError(declaredLength, maxBytes);
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  const decoded = decodeRequestBody(raw, request.headers.get('content-encoding'), maxBytes);
  return JSON.parse(new TextDecoder().decode(decoded));
}

export function readJsonRequestBody(request, maxBytes = MAX_DECOMPRESSED_BODY_BYTES) {
  return readBoundedJsonRequestBody(request, maxBytes);
}
