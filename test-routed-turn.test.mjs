import assert from "node:assert/strict";
import { test } from "bun:test";
import { handleComboChat } from "./open-sse/services/combo.js";
import { createRoutedTurn } from "./src/sse/services/routedTurn.js";

const quietLog = {
  info() {},
  warn() {},
  debug() {},
};

function makeErrorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("routed turn sends a resolved single model through the pool and core", async () => {
  const body = { model: "gpt-alias", messages: [{ role: "user", content: "hello" }] };
  const clientRawRequest = { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } };
  const request = new Request("http://localhost/v1/responses", {
    headers: { "user-agent": "routed-turn-test" },
  });
  const poolCalls = [];
  const coreCalls = [];
  const refreshedCalls = [];
  const successCalls = [];
  const formatCalls = [];
  const expectedResponse = new Response("ok");
  const originalCredentials = { connectionId: "connection-1", account: "one" };
  const refreshedCredentials = { accessToken: "refreshed-token" };

  const route = createRoutedTurn({
    resolveModel: async (modelStr) => {
      assert.equal(modelStr, "gpt-alias");
      return { provider: "openai", model: "gpt-4o-mini" };
    },
    resolveCombo: async () => null,
    getSettings: async () => ({
      providerThinking: { openai: { mode: "on" } },
      ccFilterNaming: true,
      rtkEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: "lite",
    }),
    createPool: (provider, model) => {
      poolCalls.push({ provider, model });
      return {
        execute: async (operation) => {
          const result = await operation(refreshedCredentials, originalCredentials);
          assert.equal(result.success, true);
          return result.response;
        },
      };
    },
    executeCore: async (options) => {
      coreCalls.push(options);
      await options.onCredentialsRefreshed({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        providerSpecificData: { tenant: "test" },
      });
      await options.onRequestSuccess();
      return { success: true, response: expectedResponse };
    },
    detectFormatByEndpoint: (pathname, requestBody) => {
      formatCalls.push({ pathname, requestBody });
      return "openai-responses";
    },
    updateProviderCredentials: async (connectionId, credentials) => {
      refreshedCalls.push({ connectionId, credentials });
    },
    clearAccountError: async (...args) => {
      successCalls.push(args);
    },
    log: quietLog,
  });

  const response = await route({ body, modelStr: body.model, clientRawRequest, request, apiKey: "client-key" });

  assert.strictEqual(response, expectedResponse);
  assert.deepEqual(poolCalls, [{ provider: "openai", model: "gpt-4o-mini" }]);
  assert.equal(coreCalls.length, 1);
  assert.deepEqual(coreCalls[0].body, { ...body, model: "openai/gpt-4o-mini" });
  assert.deepEqual(coreCalls[0].modelInfo, { provider: "openai", model: "gpt-4o-mini" });
  assert.strictEqual(coreCalls[0].credentials, refreshedCredentials);
  assert.strictEqual(coreCalls[0].clientRawRequest, clientRawRequest);
  assert.equal(coreCalls[0].connectionId, "connection-1");
  assert.equal(coreCalls[0].userAgent, "routed-turn-test");
  assert.equal(coreCalls[0].apiKey, "client-key");
  assert.equal(coreCalls[0].ccFilterNaming, true);
  assert.equal(coreCalls[0].rtkEnabled, true);
  assert.equal(coreCalls[0].cavemanEnabled, true);
  assert.equal(coreCalls[0].cavemanLevel, "lite");
  assert.deepEqual(coreCalls[0].providerThinking, { mode: "on" });
  assert.equal(coreCalls[0].sourceFormatOverride, "openai-responses");
  assert.deepEqual(formatCalls, [{ pathname: "/v1/responses", requestBody: body }]);
  assert.deepEqual(refreshedCalls, [{
    connectionId: "connection-1",
    credentials: {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      providerSpecificData: { tenant: "test" },
      testStatus: "active",
    },
  }]);
  assert.deepEqual(successCalls, [["connection-1", originalCredentials, "gpt-4o-mini"]]);
});

test("routed turn expands combos with the configured strategy and sticky limit", async () => {
  const body = { model: "routed-turn-combo", input: [] };
  const comboCalls = [];
  const attemptedModels = [];

  const route = createRoutedTurn({
    resolveModel: async (modelStr) => modelStr === body.model
      ? { provider: null, model: null }
      : { provider: "anthropic", model: modelStr.split("/")[1] },
    resolveCombo: async (modelStr) => modelStr === body.model ? ["anthropic/claude-one", "anthropic/claude-two"] : null,
    getSettings: async () => ({
      comboStrategies: { [body.model]: { fallbackStrategy: "round-robin" } },
      comboStrategy: "fallback",
      comboStickyRoundRobinLimit: 2,
    }),
    handleCombo: async (options) => {
      comboCalls.push(options);
      return handleComboChat(options);
    },
    createPool: (provider, model) => ({
      execute: async (operation) => {
        const result = await operation(
          { accessToken: "token" },
          { connectionId: `${provider}-${model}` },
        );
        return result.response;
      },
    }),
    executeCore: async ({ modelInfo }) => {
      attemptedModels.push(`${modelInfo.provider}/${modelInfo.model}`);
      return { success: true, response: new Response("combo-ok") };
    },
    log: quietLog,
  });

  const response = await route({ body, modelStr: body.model });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "combo-ok");
  assert.equal(comboCalls.length, 1);
  assert.deepEqual(comboCalls[0].models, ["anthropic/claude-one", "anthropic/claude-two"]);
  assert.equal(comboCalls[0].comboName, body.model);
  assert.equal(comboCalls[0].comboStrategy, "round-robin");
  assert.equal(comboCalls[0].comboStickyLimit, 2);
  assert.deepEqual(attemptedModels, ["anthropic/claude-one"]);
});

test("routed turn preserves combo fallback after a model error", async () => {
  const comboName = "routed-turn-fallback-combo";
  const attemptedModels = [];
  const route = createRoutedTurn({
    resolveModel: async (modelStr) => modelStr === comboName
      ? { provider: null, model: null }
      : { provider: "openai", model: modelStr.split("/")[1] },
    resolveCombo: async (modelStr) => modelStr === comboName ? ["openai/first", "openai/second"] : null,
    getSettings: async () => ({ comboStrategy: "fallback" }),
    createPool: (provider, model) => ({
      execute: async (operation) => {
        const result = await operation(
          { accessToken: "token" },
          { connectionId: `${provider}-${model}` },
        );
        return result.response;
      },
    }),
    executeCore: async ({ modelInfo }) => {
      attemptedModels.push(modelInfo.model);
      if (modelInfo.model === "first") {
        return {
          success: false,
          status: 500,
          error: "first provider failed",
          response: makeErrorResponse(500, "first provider failed"),
        };
      }
      return { success: true, response: new Response("combo-fallback-ok") };
    },
    log: quietLog,
  });

  const response = await route({ body: { model: comboName }, modelStr: comboName });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "combo-fallback-ok");
  assert.deepEqual(attemptedModels, ["first", "second"]);
});

test("routed turn returns the existing invalid-model response", async () => {
  const errors = [];
  const route = createRoutedTurn({
    resolveModel: async () => ({ provider: null, model: null }),
    resolveCombo: async () => null,
    errorResponse: (status, message) => {
      errors.push({ status, message });
      return new Response(message, { status });
    },
    log: quietLog,
  });

  const response = await route({ body: { model: "not-a-model" }, modelStr: "not-a-model" });

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid model format");
  assert.deepEqual(errors, [{ status: 400, message: "Invalid model format" }]);
});

test("routed turn preserves pool fallback and core error results", async () => {
  const coreCalls = [];
  const route = createRoutedTurn({
    resolveModel: async () => ({ provider: "openai", model: "gpt-fallback" }),
    resolveCombo: async () => null,
    getSettings: async () => ({}),
    createPool: () => ({
      execute: async (operation) => {
        const first = await operation(
          { accessToken: "first-token" },
          { connectionId: "connection-failed" },
        );
        assert.equal(first.success, false);
        assert.equal(first.status, 503);
        assert.equal(first.error, "provider unavailable");
        assert.equal(first.response.status, 503);
        const second = await operation(
          { accessToken: "second-token" },
          { connectionId: "connection-success" },
        );
        assert.equal(second.success, true);
        return second.response;
      },
    }),
    executeCore: async ({ connectionId }) => {
      coreCalls.push(connectionId);
      if (connectionId === "connection-failed") {
        return {
          success: false,
          status: 503,
          error: "provider unavailable",
          response: makeErrorResponse(503, "provider unavailable"),
        };
      }
      return { success: true, response: new Response("fallback-ok") };
    },
    log: quietLog,
  });

  const response = await route({ body: { model: "openai/gpt-fallback" }, modelStr: "openai/gpt-fallback" });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "fallback-ok");
  assert.deepEqual(coreCalls, ["connection-failed", "connection-success"]);
});
