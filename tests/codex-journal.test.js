import { describe, expect, test } from "bun:test";

import {
  buildRestorePlan,
  createCodexJournal,
} from "../src/lib/codex/journal.js";

describe("Codex integration journal", () => {
  test("restores unchanged injected files and refuses to overwrite later user edits", () => {
    const journal = createCodexJournal({
      files: {
        config: { before: "user config", after: "injected config" },
        catalog: { before: null, after: "generated catalog" },
      },
      manifest: { version: 1, ownedSlugs: ["openrouter/moonshotai-kimi-k3"] },
    });

    expect(
      buildRestorePlan(journal, {
        config: "injected config",
        catalog: "generated catalog",
      }),
    ).toEqual({
      restorations: {
        config: { action: "write", content: "user config" },
        catalog: { action: "remove" },
      },
      conflicts: [],
    });

    expect(
      buildRestorePlan(journal, {
        config: "user edited after setup",
        catalog: "generated catalog",
      }),
    ).toEqual({
      restorations: {
        catalog: { action: "remove" },
      },
      conflicts: ["config"],
    });
  });
});
