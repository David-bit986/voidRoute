import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RETRYABLE_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_RETRY_DELAYS_MS = [10, 50, 100];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const retryDelay = RENAME_RETRY_DELAYS_MS[attempt];
      if (
        retryDelay === undefined ||
        !RETRYABLE_RENAME_ERRORS.has(error?.code)
      ) {
        throw error;
      }
      await delay(retryDelay);
    }
  }
}

export async function writeFileAtomic(target, content, options = "utf8") {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, content, options);
    await replaceFile(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
