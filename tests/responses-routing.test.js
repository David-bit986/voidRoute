import { describe, expect, test } from "bun:test";

import { FORMATS } from "../open-sse/translator/formats.js";
import {
  initState,
  translateRequest,
  translateResponse,
} from "../open-sse/translator/index.js";

describe("Responses routing through OpenRouter", () => {
  test("translates a Kimi tool request and streamed tool call round trip", () => {
    const upstreamBody = translateRequest({
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI,
      model: "moonshotai/kimi-k3",
      provider: "openrouter",
      stream: true,
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
    });
    upstreamBody.model = "moonshotai/kimi-k3";

    expect(upstreamBody).toMatchObject({
      model: "moonshotai/kimi-k3",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Weather in Paris?" }],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.model = "moonshotai/kimi-k3";
    const chunks = [
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"Paris"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-test",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls" },
        ],
      },
    ];
    const events = chunks.flatMap((chunk) =>
      translateResponse(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        chunk,
        state,
      ),
    );

    expect(events.map(({ event }) => event)).toEqual(
      expect.arrayContaining([
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
        "response.completed",
      ]),
    );
    expect(
      events
        .filter(({ event }) => event === "response.function_call_arguments.delta")
        .map(({ data }) => data.delta)
        .join(""),
    ).toBe('{"city":"Paris"}');
  });
});
