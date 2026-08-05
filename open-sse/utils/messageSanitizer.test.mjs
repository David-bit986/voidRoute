import { test, expect } from "bun:test";
import { sanitizeEmptyToolCalls } from "./messageSanitizer.js";
import { filterToOpenAIFormat } from "../translator/helpers/openaiHelper.js";

test("drops empty tool_calls from assistant messages, keeps real ones", () => {
  const body = {
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a", tool_calls: [] },
      {
        role: "assistant",
        content: "b",
        tool_calls: [
          { id: "x", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
    ],
  };
  sanitizeEmptyToolCalls(body);
  expect(body.messages[2].tool_calls).toBeUndefined();
  expect(body.messages[3].tool_calls).toHaveLength(1);
});

test("ignores bodies without messages", () => {
  expect(sanitizeEmptyToolCalls(null)).toBeNull();
  expect(sanitizeEmptyToolCalls({ input: [] })).toEqual({ input: [] });
});

test("filterToOpenAIFormat strips empty tool_calls instead of forwarding them", () => {
  const out = filterToOpenAIFormat({
    messages: [
      { role: "assistant", content: "no calls", tool_calls: [] },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "y", type: "function", function: { name: "g", arguments: "{}" } }],
      },
    ],
  });
  expect(out.messages[0].tool_calls).toBeUndefined();
  expect(out.messages[1].tool_calls).toHaveLength(1);
  expect(out.messages).toHaveLength(2);
});
