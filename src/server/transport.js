import { timingSafeEqual } from 'node:crypto';
import {
  DecompressedBodyTooLargeError,
  MAX_DECOMPRESSED_BODY_BYTES,
  readJsonRequestBody,
  UnsupportedContentEncodingError,
} from './request-body.js';

const CORS_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';
export const DEFAULT_HOSTNAME = '127.0.0.1';
export const MAX_REQUEST_BODY_SIZE = 50 * 1024 * 1024;
export const TRANSPORT_AUTH_HEADER = 'x-opencodex-api-key';

function normalizeHostname(hostname) {
  return typeof hostname === 'string' && hostname.trim() ? hostname.trim() : DEFAULT_HOSTNAME;
}

export function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseHost(host) {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function isLoopbackRequestHost(host) {
  const hostname = parseHost(host);
  return !hostname || isLoopbackHostname(hostname);
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function allowedOrigin(request) {
  if (!request) return null;
  const origin = request.headers.get('origin');
  return origin && isLoopbackOrigin(origin) ? origin : null;
}

function corsHeaders(request) {
  const headers = new Headers();
  const origin = allowedOrigin(request);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function originRejectedResponse() {
  return jsonResponse({
    error: {
      message: 'Cross-origin request blocked',
      type: 'permission_error',
      code: 'origin_rejected',
    },
  }, 403);
}

function authenticationRequiredResponse() {
  return jsonResponse({
    error: {
      message: 'opencodex API key required',
      type: 'authentication_error',
      code: 'authentication_error',
    },
  }, 401);
}

function preflightResponse(request) {
  const headers = corsHeaders(request);
  headers.set('Access-Control-Allow-Methods', CORS_METHODS);
  headers.append('Vary', 'Access-Control-Request-Headers');

  const requestedHeaders = request.headers.get('access-control-request-headers');
  if (requestedHeaders) {
    headers.set('Access-Control-Allow-Headers', requestedHeaders);
  }

  return new Response(null, { status: 204, headers });
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  const existingVary = headers.get('Vary');
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Vary');
  for (const [name, value] of corsHeaders(request).entries()) {
    if (name === 'Vary' && existingVary) {
      headers.set('Vary', existingVary.split(',').map((part) => part.trim()).includes(value)
        ? existingVary
        : `${existingVary}, ${value}`);
    } else {
      headers.set(name, value);
    }
  }
  if (existingVary && !headers.has('Vary')) headers.set('Vary', existingVary);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function notFoundResponse() {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function internalErrorResponse() {
  return jsonResponse({
    error: {
      message: 'Internal server error',
      type: 'server_error',
      code: 'internal_server_error',
    },
  }, 500);
}

function normalizeRoutePath(pathname) {
  if (pathname.length <= 1) return pathname;
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function cacheRequestJson(request, bodyPromise) {
  Object.defineProperty(request, 'json', {
    configurable: true,
    value: () => bodyPromise,
  });

  return request;
}

function buildChatRawRequest(request, url, body) {
  return {
    endpoint: `${url.pathname}${url.search}`,
    body,
    headers: Object.fromEntries(request.headers.entries()),
  };
}

function requestBodyErrorResponse(error) {
  if (error instanceof UnsupportedContentEncodingError) {
    return jsonResponse({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        code: 'unsupported_content_encoding',
      },
    }, 415);
  }

  if (error instanceof DecompressedBodyTooLargeError) {
    return jsonResponse({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        code: 'request_body_too_large',
      },
    }, 413);
  }

  return jsonResponse({
    error: {
      message: 'Invalid JSON body',
      type: 'invalid_request_error',
      code: 'invalid_request_error',
    },
  }, 400);
}

function disableLongRequestTimeout(request, server, route) {
  if (typeof server?.timeout !== 'function') return;

  const acceptsEventStream = request.headers.get('accept')?.toLowerCase().includes('text/event-stream');
  // Chat/image routes and explicit SSE requests are intentionally unbounded;
  // short unary routes retain Bun's normal request timeout.
  if (route?.longRunning || acceptsEventStream) {
    server.timeout(request, 0);
  }
}

function secureEquals(actual, expected) {
  if (!actual || !expected) return false;
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function buildRouteTable({ handleChat, getModels, handlers }) {
  const definitions = [
    ['GET /v1/models', { handler: getModels, kind: 'models' }],
    ['HEAD /v1/models', { handler: getModels, kind: 'models' }],
    ['POST /v1/chat/completions', { handler: handleChat, kind: 'chat', longRunning: true }],
    ['POST /v1/messages', { handler: handleChat, kind: 'chat', longRunning: true }],
    ['POST /v1/responses', { handler: handleChat, kind: 'chat', longRunning: true }],
    ['POST /v1/embeddings', { handler: handlers.embeddings }],
    ['POST /v1/web/fetch', { handler: handlers.fetch }],
    ['POST /v1/search', { handler: handlers.search }],
    ['POST /v1/images/generations', { handler: handlers.imageGeneration, longRunning: true }],
    ['POST /v1/audio/speech', { handler: handlers.tts }],
    ['POST /v1/audio/transcriptions', { handler: handlers.stt }],
  ];
  const table = new Map();

  for (const [route, definition] of definitions) {
    if (table.has(route)) throw new TypeError(`Duplicate route ${route}`);
    if (typeof definition.handler !== 'function') {
      throw new TypeError(`Missing handler for ${route}`);
    }
    table.set(route, definition);
  }

  return table;
}

export function createNativeRequestHandler({
  handleChat,
  getModels,
  handlers = {},
  hostname = DEFAULT_HOSTNAME,
  authToken = process.env.OPENCODEX_API_AUTH_TOKEN?.trim() || '',
  maxDecompressedBodyBytes = MAX_DECOMPRESSED_BODY_BYTES,
}) {
  if (typeof handleChat !== 'function') throw new TypeError('handleChat must be a function');
  if (typeof getModels !== 'function') throw new TypeError('getModels must be a function');
  const routeTable = buildRouteTable({ handleChat, getModels, handlers });
  const bindHostname = normalizeHostname(hostname);
  const requiresAuth = !isLoopbackHostname(bindHostname);

  return async function handleRequest(request, server) {
    const url = new URL(request.url);
    const routePath = normalizeRoutePath(url.pathname);

    if (request.method === 'OPTIONS') {
      if (!isLoopbackRequestHost(request.headers.get('host')) || (request.headers.get('origin') && !isLoopbackOrigin(request.headers.get('origin')))) {
        return originRejectedResponse();
      }
      return preflightResponse(request);
    }

    if ((!requiresAuth && !isLoopbackRequestHost(request.headers.get('host')))
      || (request.headers.get('origin') && !isLoopbackOrigin(request.headers.get('origin')))) {
      return originRejectedResponse();
    }

    if (requiresAuth && !secureEquals(request.headers.get(TRANSPORT_AUTH_HEADER)?.trim(), authToken)) {
      return withCors(authenticationRequiredResponse(), request);
    }

    // Codex tries this transport first because its built-in OpenAI provider advertises WebSockets.
    // Phase 1 intentionally rejects the upgrade so Codex falls back to HTTP/SSE.
    if (
      routePath === '/v1/responses'
      && request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    ) {
      const response = jsonResponse({
        error: {
          message: 'Responses WebSocket transport is disabled; use HTTP',
          type: 'upgrade_required',
          code: 'upgrade_required',
        },
      }, 426);
      const headers = new Headers(response.headers);
      headers.set('Connection', 'close');
      return withCors(new Response(response.body, {
        status: response.status,
        headers,
      }), request);
    }

    try {
      const route = routeTable.get(`${request.method} ${routePath}`);
      disableLongRequestTimeout(request, server, route);

      if (route?.kind === 'models') {
        return withCors(jsonResponse(await route.handler(request)), request);
      }

      if (!route) {
        return withCors(notFoundResponse(), request);
      }

      if (route.kind === 'chat') {
        let body;
        try {
          body = await (routePath === '/v1/responses'
            ? readJsonRequestBody(request, maxDecompressedBodyBytes)
            : request.json());
        } catch (error) {
          return withCors(requestBodyErrorResponse(error), request);
        }

        const requestWithCachedJson = cacheRequestJson(request, Promise.resolve(body));
        const response = await handleChat(
          requestWithCachedJson,
          buildChatRawRequest(requestWithCachedJson, url, body),
        );
        return withCors(response, request);
      }

      return withCors(await route.handler(request), request);
    } catch (error) {
      console.error('[Transport] request failed:', error);
      return withCors(internalErrorResponse(), request);
    }
  };
}

export function assertServerAuthConfig(hostname, authToken = process.env.OPENCODEX_API_AUTH_TOKEN?.trim() || '') {
  const bindHostname = normalizeHostname(hostname);
  if (!isLoopbackHostname(bindHostname) && !authToken) {
    throw new Error('OPENCODEX_API_AUTH_TOKEN is required when binding voidRoute to a non-loopback hostname');
  }
  return { hostname: bindHostname, authToken };
}

export function startNativeServer({
  port,
  fetch,
  onListening,
  hostname = DEFAULT_HOSTNAME,
  authToken = process.env.OPENCODEX_API_AUTH_TOKEN?.trim() || '',
}) {
  const authConfig = assertServerAuthConfig(hostname, authToken);
  const guardedFetch = !isLoopbackHostname(authConfig.hostname)
    ? async (request, server) => {
      if (request.method === 'OPTIONS') return fetch(request, server);
      if (!secureEquals(request.headers.get(TRANSPORT_AUTH_HEADER)?.trim(), authConfig.authToken)) {
        return withCors(authenticationRequiredResponse(), request);
      }
      return fetch(request, server);
    }
    : fetch;
  const server = Bun.serve({
    hostname: authConfig.hostname,
    port,
    idleTimeout: 255,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    fetch: guardedFetch,
  });

  try {
    onListening?.(server);
  } catch (error) {
    void server.stop(true);
    throw error;
  }

  return server;
}
