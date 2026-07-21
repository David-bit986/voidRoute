import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "../src/lib/codex/atomicFile.js";
import {
  buildCodexCatalog,
  loadCodexCatalogBaseline,
  writeCodexCatalogArtifacts,
} from "../src/lib/codex/catalog.js";
import { getCodexPaths } from "../src/lib/codex/paths.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Codex integration files", () => {
  test("uses CODEX_HOME for every managed and read-only Codex path", () => {
    const codexHome = path.resolve("C:/test/codex-home");

    expect(
      getCodexPaths({ env: { CODEX_HOME: codexHome }, homeDir: "C:/ignored" }),
    ).toEqual({
      home: codexHome,
      config: path.join(codexHome, "config.toml"),
      catalog: path.join(codexHome, "voidroute-catalog.json"),
      modelMap: path.join(codexHome, "voidroute-model-map.json"),
      state: path.join(codexHome, "voidroute-state.json"),
      backup: path.join(codexHome, "voidroute-catalog.backup.json"),
      modelsCache: path.join(codexHome, "models_cache.json"),
      auth: path.join(codexHome, "auth.json"),
    });
  });

  test("atomically replaces a file without leaving a temporary sibling", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-atomic-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "catalog.json");
    await writeFile(target, "old");

    await writeFileAtomic(target, "new");

    expect({ content: await readFile(target, "utf8"), files: await readdir(directory) })
      .toEqual({ content: "new", files: ["catalog.json"] });
  });

  test("loads the first valid baseline without modifying any source file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-baseline-"));
    temporaryDirectories.push(directory);
    const selected = path.join(directory, "selected.json");
    const backup = path.join(directory, "backup.json");
    const cache = path.join(directory, "models_cache.json");
    const validBackup = { models: [{ slug: "gpt-backup", base_instructions: "ok" }] };
    await writeFile(selected, "not json");
    await writeFile(backup, JSON.stringify(validBackup));
    await writeFile(cache, JSON.stringify({ models: [{ slug: "gpt-cache" }] }));

    const result = await loadCodexCatalogBaseline({
      selectedCatalogPath: selected,
      backupPath: backup,
      modelsCachePath: cache,
    });

    expect(result).toEqual({ catalog: validBackup, source: backup });
    expect(await readFile(backup, "utf8")).toBe(JSON.stringify(validBackup));
  });

  test("writes a validated catalog and exact model map as JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voidroute-catalog-"));
    temporaryDirectories.push(directory);
    const paths = getCodexPaths({ env: { CODEX_HOME: directory } });
    const artifacts = buildCodexCatalog({
      baseline: {
        models: [
          {
            slug: "gpt-native",
            display_name: "GPT Native",
            base_instructions: "You are Codex, an agent based on GPT-5.",
            visibility: "list",
            priority: 9,
          },
        ],
      },
      discoveredModels: [
        { provider: "openrouter", id: "moonshotai/kimi-k3" },
      ],
    });

    await writeCodexCatalogArtifacts({ paths, artifacts });

    expect({
      catalog: JSON.parse(await readFile(paths.catalog, "utf8")),
      modelMap: JSON.parse(await readFile(paths.modelMap, "utf8")),
    }).toEqual({
      catalog: artifacts.catalog,
      modelMap: artifacts.modelMap,
    });
  });
});
