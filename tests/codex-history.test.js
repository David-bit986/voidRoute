import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrateLegacyCodexHistory } from "../src/lib/codex/history.js";
import { getCodexPaths } from "../src/lib/codex/paths.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Codex history migration", () => {
  test("restores legacy voidRoute threads to the native provider", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-history-"));
    temporaryDirectories.push(directory);
    const paths = getCodexPaths({ env: { CODEX_HOME: directory } });
    const threadId = "thread-legacy";
    const rolloutPath = path.join(directory, "rollout.jsonl");
    await writeFile(
      rolloutPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: threadId, model_provider: "voidRoute" },
      })}\n${JSON.stringify({ type: "event_msg", payload: {} })}\n`,
    );

    const db = new Database(paths.historyDb);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        model_provider TEXT NOT NULL
      )
    `);
    db.query("INSERT INTO threads VALUES (?, ?, ?)").run(
      threadId,
      rolloutPath,
      "voidRoute",
    );
    db.close();

    await expect(migrateLegacyCodexHistory({ paths })).resolves.toEqual({
      rows: 1,
      files: 1,
      deferred: false,
    });

    const check = new Database(paths.historyDb, { readonly: true });
    expect(check.query("SELECT model_provider FROM threads").get()).toEqual({
      model_provider: "openai",
    });
    check.close();
    const firstLine = (await readFile(rolloutPath, "utf8")).split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("openai");
  });
});
