import { createHash } from "node:crypto";

export function hashCodexContent(content) {
  if (content === null || content === undefined) {
    return null;
  }
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createCodexJournal({ files, manifest }) {
  const journalFiles = {};

  for (const [name, { before, after }] of Object.entries(files)) {
    journalFiles[name] = {
      before: before ?? null,
      injectedHash: hashCodexContent(after),
    };
  }

  return {
    version: 1,
    files: journalFiles,
    manifest,
  };
}

export function buildRestorePlan(journal, currentFiles) {
  const restorations = {};
  const conflicts = [];

  for (const [name, entry] of Object.entries(journal.files)) {
    const currentHash = hashCodexContent(currentFiles[name]);
    if (currentHash !== entry.injectedHash) {
      conflicts.push(name);
      continue;
    }

    restorations[name] = entry.before === null
      ? { action: "remove" }
      : { action: "write", content: entry.before };
  }

  return { restorations, conflicts };
}
