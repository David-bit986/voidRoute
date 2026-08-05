import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

let dataDirectory;
let server;
let baseUrl;
let receivedBody;

beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "voidroute-responses-"));
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      {
        id: "chatcmpl-kimi",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
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
        id: "chatcmpl-kimi",
        object: "chat.completion.chunk",
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
        id: "chatcmpl-kimi",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls" },
        ],
      },
    ];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/chat/completions`;
});

afterAll(async () => {
  if (server) {
    server.close();
    await once(server, "close");
  }
  if (dataDirectory) {
    await rm(dataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 50,
    });
  }
});

describe("OpenRouter Responses pipeline", () => {
  test("sends native Kimi tools upstream and returns valid Responses tool events", async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/openrouterResponsesChild.js"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATA_DIR: dataDirectory,
          VOIDROUTE_TEST_OPENROUTER_URL: baseUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const resultLine = stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("__VOIDROUTE_RESULT__"));

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(resultLine).toBeDefined();
    const { responseText } = JSON.parse(
      resultLine.slice("__VOIDROUTE_RESULT__".length),
    );
    expect(receivedBody).toMatchObject({
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
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    expect(responseText).toContain("response.function_call_arguments.delta");
    expect(responseText).toContain("response.function_call_arguments.done");
    expect(responseText).toContain("response.output_item.done");
    expect(responseText).toContain("response.completed");
  });
});
