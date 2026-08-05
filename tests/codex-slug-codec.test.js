import { describe, expect, test } from "bun:test";

import {
  decodeRoutedModelId,
  routedSlug,
  slugEquals,
} from "../src/lib/codex/slugCodec.js";
import { buildRoutedModelMap } from "../src/lib/codex/modelMap.js";

describe("Codex routed model slugs", () => {
  test("makes a nested OpenRouter model selectable in the Codex picker", () => {
    expect(routedSlug("openrouter", "moonshotai/kimi-k3")).toBe(
      "openrouter/moonshotai-kimi-k3",
    );
  });

  test("keeps an exact native nested model selector unchanged", () => {
    expect(
      decodeRoutedModelId("moonshotai/kimi-k3", ["moonshotai/kimi-k3"]),
    ).toBe("moonshotai/kimi-k3");
  });

  test("decodes a unique picker alias back to its native model ID", () => {
    expect(
      decodeRoutedModelId("moonshotai-kimi-k3", ["moonshotai/kimi-k3"]),
    ).toBe("moonshotai/kimi-k3");
  });

  test("refuses to guess when two native IDs share one picker alias", () => {
    expect(decodeRoutedModelId("a-b-c", ["a/b-c", "a-b/c"])).toBe(
      "a-b-c",
    );
  });

  test("matches either a raw or picker-safe stored routed slug", () => {
    const rawMatches = slugEquals(
      "openrouter/moonshotai/kimi-k3",
      "openrouter",
      "moonshotai/kimi-k3",
    );
    const pickerMatches = slugEquals(
      "openrouter/moonshotai-kimi-k3",
      "openrouter",
      "moonshotai/kimi-k3",
    );

    expect({ rawMatches, pickerMatches }).toEqual({
      rawMatches: true,
      pickerMatches: true,
    });
  });

  test("publishes only unambiguous picker aliases and reports collisions", () => {
    const result = buildRoutedModelMap([
      { provider: "openrouter", id: "moonshotai/kimi-k3" },
      { provider: "openrouter", id: "a/b-c" },
      { provider: "openrouter", id: "a-b/c" },
    ]);

    expect(result).toEqual({
      models: {
        "openrouter/moonshotai-kimi-k3": {
          provider: "openrouter",
          model: "moonshotai/kimi-k3",
        },
      },
      collisions: [
        {
          slug: "openrouter/a-b-c",
          models: ["a-b/c", "a/b-c"],
        },
      ],
    });
  });
});
