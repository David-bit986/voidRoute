import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { test } from 'bun:test';
import { renameCustomModelAlias } from './src/lib/db/repos/aliasRepo.js';

function createMemoryAdapter() {
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE kv(scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope, key))`);
  return {
    all(sql, params = []) { return raw.prepare(sql).all(...params); },
    run(sql, params = []) { return raw.prepare(sql).run(...params); },
    get(sql, params = []) { return raw.prepare(sql).get(...params); },
    transaction(fn) { const tx = raw.transaction(fn); return tx(); },
  };
}

function seedCustomModel(db, providerAlias, id, name) {
  db.run(
    "INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)",
    [`${providerAlias}|${id}|llm`, JSON.stringify({ providerAlias, id, type: 'llm', name })],
  );
}

function seedAlias(db, alias, model) {
  db.run("INSERT INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)", [alias, JSON.stringify(model)]);
}

function listCustomModels(db) {
  return db.all("SELECT value FROM kv WHERE scope = 'customModels'").map((r) => JSON.parse(r.value));
}

function listAliases(db) {
  const out = {};
  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'modelAliases'")) {
    out[r.key] = JSON.parse(r.value);
  }
  return out;
}

test('renaming a custom provider prefix migrates customModels and modelAliases', async () => {
  const db = createMemoryAdapter();
  seedCustomModel(db, 'b.ai', 'glm-4.7', 'glm-4.7');
  seedCustomModel(db, 'b.ai', 'qwen3', 'qwen3');
  seedCustomModel(db, 'other', 'keep', 'keep');
  seedAlias(db, 'myb', 'b.ai/glm-4.7');
  seedAlias(db, 'keepAlias', 'b.ai/other-model');
  seedAlias(db, 'unrelated', 'kiro/whatever');

  const result = await renameCustomModelAlias('b.ai', 'b', db);
  assert.deepEqual(result, { renamedModels: 2, renamedAliases: 2 });

  const sorted = listCustomModels(db).map((m) => `${m.providerAlias}/${m.id}`).sort();
  assert.deepEqual(sorted, ['b/glm-4.7', 'b/qwen3', 'other/keep']);

  const aliases = listAliases(db);
  assert.equal(aliases.myb, 'b/glm-4.7');
  assert.equal(aliases.keepAlias, 'b/other-model');
  assert.equal(aliases.unrelated, 'kiro/whatever');
});

test('renaming to the same prefix is a no-op', async () => {
  const db = createMemoryAdapter();
  seedCustomModel(db, 'b', 'sub', 'sub');
  const result = await renameCustomModelAlias('b', 'b', db);
  assert.deepEqual(result, { renamedModels: 0, renamedAliases: 0 });
  assert.deepEqual(listCustomModels(db).map((m) => `${m.providerAlias}/${m.id}`), ['b/sub']);
});

test('renaming only touches rows owned by the source prefix', async () => {
  const db = createMemoryAdapter();
  seedCustomModel(db, 'b', 'sub', 'sub');
  const result = await renameCustomModelAlias('missing-prefix', 'm', db);
  assert.deepEqual(result, { renamedModels: 0, renamedAliases: 0 });
  assert.deepEqual(listCustomModels(db).map((m) => `${m.providerAlias}/${m.id}`), ['b/sub']);
});

test('exact alias value equal to the prefix is migrated, not left dangling', async () => {
  const db = createMemoryAdapter();
  seedAlias(db, 'raw', 'b.ai');
  const result = await renameCustomModelAlias('b.ai', 'b', db);
  assert.deepEqual(result, { renamedModels: 0, renamedAliases: 1 });
  assert.equal(listAliases(db).raw, 'b');
});