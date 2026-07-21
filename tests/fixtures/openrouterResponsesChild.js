const { PROVIDERS } = await import("../../open-sse/config/providers.js");
PROVIDERS.openrouter.baseUrl = process.env.VOIDROUTE_TEST_OPENROUTER_URL;

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const result = await handleChatCore({
  body: {
    model: "openrouter/moonshotai-kimi-k3",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Weather in Paris?" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object" },
      },
    ],
    stream: true,
  },
  modelInfo: { provider: "openrouter", model: "moonshotai/kimi-k3" },
  credentials: { apiKey: "test-openrouter-key" },
  log: { debug() {}, info() {}, warn() {}, error() {} },
  connectionId: null,
  clientRawRequest: {
    endpoint: "/v1/responses",
    body: {},
    headers: { accept: "text/event-stream" },
  },
  sourceFormatOverride: FORMATS.OPENAI_RESPONSES,
});

const responseText = await result.response.text();
await Bun.write(
  Bun.stdout,
  `__VOIDROUTE_RESULT__${JSON.stringify({ responseText })}\n`,
);
process.exit(0);
