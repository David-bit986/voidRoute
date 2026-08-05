import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveCodexPickerModel } from "../src/lib/codex/modelMapReader.js";
import { getCodexPaths } from "../src/lib/codex/paths.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Codex picker model routing", () => {
  test("resolves an exact picker alias while leaving raw nested selectors alone", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-map-"));
    temporaryDirectories.push(directory);
    const paths = getCodexPaths({ env: { CODEX_HOME: directory } });
    await writeFile(
      paths.modelMap,
      JSON.stringify({
        models: {
          "openrouter/moonshotai-kimi-k3": {
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
          },
          "ag/gemini-2.5-pro": {
            provider: "ag",
            model: "gemini-2.5-pro",
          },
        },
      }),
    );

    expect(
      await resolveCodexPickerModel(
        "openrouter/moonshotai-kimi-k3",
        { paths },
      ),
    ).toEqual({ provider: "openrouter", model: "moonshotai/kimi-k3" });
    expect(
      await resolveCodexPickerModel(
        "openrouter/moonshotai/kimi-k3",
        { paths },
      ),
    ).toBeNull();
  });

  test("decodes a Codex picker alias at the shared request-routing boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-route-"));
    temporaryDirectories.push(directory);
    const paths = getCodexPaths({ env: { CODEX_HOME: directory } });
    await writeFile(
      paths.modelMap,
      JSON.stringify({
        models: {
          "openrouter/moonshotai-kimi-k3": {
            provider: "openrouter",
            model: "moonshotai/kimi-k3",
          },
          "ag/gemini-2.5-pro": {
            provider: "ag",
            model: "gemini-2.5-pro",
          },
        },
      }),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = directory;

    try {
      const { getModelInfo } = await import("../src/sse/services/model.js");
      expect(await getModelInfo("openrouter/moonshotai-kimi-k3")).toEqual({
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
      });
      expect(await getModelInfo("ag/gemini-2.5-pro")).toEqual({
        provider: "antigravity",
        model: "gemini-2.5-pro",
      });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});
