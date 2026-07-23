import { existsSync, openSync, readFileSync, closeSync, writeSync } from "node:fs";
import path from "node:path";

function isRecoverableLock(error) {
  const code = typeof error === "object" && error ? error.code : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    ["SQLITE_BUSY", "SQLITE_LOCKED", "EBUSY", "EPERM", "EACCES"].includes(code) ||
    message.includes("database is locked") ||
    message.includes("database is busy") ||
    message.includes("resource busy") ||
    message.includes("permission denied")
  );
}

function patchRolloutProvider(rolloutPath, threadId, provider) {
  if (!rolloutPath || !existsSync(rolloutPath)) return false;

  let content;
  try {
    content = readFileSync(rolloutPath, "utf8");
  } catch {
    return false;
  }

  const newline = content.indexOf("\n");
  if (newline < 0) return false;
  const firstLine = content.slice(0, newline);
  let record;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return false;
  }

  if (
    record?.type !== "session_meta" ||
    record?.payload?.id !== threadId ||
    record.payload.model_provider === provider
  ) {
    return false;
  }

  const match = firstLine.match(/"model_provider"\s*:\s*"([^"\\]*)"/);
  if (!match || match.index === undefined) return false;
  const replacement = `"model_provider":"${provider}"`;
  if (Buffer.byteLength(replacement) > Buffer.byteLength(match[0])) return false;

  const padding = " ".repeat(Buffer.byteLength(match[0]) - Buffer.byteLength(replacement));
  const patchedLine =
    firstLine.slice(0, match.index) +
    replacement +
    padding +
    firstLine.slice(match.index + match[0].length);
  if (Buffer.byteLength(patchedLine) !== Buffer.byteLength(firstLine)) return false;

  const handle = openSync(rolloutPath, "r+");
  try {
    const bytes = Buffer.from(patchedLine, "utf8");
    writeSync(handle, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(handle);
  }
  return true;
}

export async function migrateLegacyCodexHistory({
  paths,
  fromProvider = "voidRoute",
  toProvider = "openai",
} = {}) {
  const stateDbPath = paths?.historyDb || path.join(paths?.home || "", "state_5.sqlite");
  if (!stateDbPath || !existsSync(stateDbPath)) {
    return { rows: 0, files: 0, deferred: false };
  }

  let Database;
  try {
    ({ Database } = await import("bun:sqlite"));
  } catch {
    return { rows: 0, files: 0, deferred: true };
  }

  let db;
  try {
    db = new Database(stateDbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db
      .query(
        "SELECT id, rollout_path FROM threads WHERE model_provider = ?",
      )
      .all(fromProvider);
    if (rows.length === 0) {
      return { rows: 0, files: 0, deferred: false };
    }

    const update = db.transaction(() => {
      const statement = db.query(
        "UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?",
      );
      for (const row of rows) statement.run(toProvider, row.id, fromProvider);
    });
    update();

    let files = 0;
    for (const row of rows) {
      try {
        if (patchRolloutProvider(row.rollout_path, row.id, toProvider)) files += 1;
      } catch {
        // The database tag is the source of truth for list visibility. A missing
        // rollout is left untouched rather than blocking other history rows.
      }
    }
    return { rows: rows.length, files, deferred: false };
  } catch (error) {
    if (isRecoverableLock(error)) {
      return { rows: 0, files: 0, deferred: true };
    }
    // History repair is best-effort. A future Codex schema must not prevent
    // the config/catalog setup from completing.
    return { rows: 0, files: 0, deferred: true };
  } finally {
    db?.close();
  }
}
