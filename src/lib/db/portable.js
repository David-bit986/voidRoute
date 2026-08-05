// Portable DB export/import + the shared row-insert helpers.
//
// Single home for the column mappings used by both the user-facing
// export/import and the one-time legacy JSON migration. Previously this
// logic was split across db/index.js (exportDb/importDb) and migrate.js
// (importLegacyMain), which had drifted into two near-identical copies.

import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// ─── Shared row-insert helpers (single source of truth) ─────────────────────
export function insertSettingsRow(adapter, settings) {
  if (!settings) return;
  adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(settings)]);
}

export function insertConnectionRow(adapter, c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  adapter.run(
    `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
  );
}

export function insertNodeRow(adapter, n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  adapter.run(
    `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
  );
}

export function insertProxyPoolRow(adapter, p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  adapter.run(
    `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
  );
}

export function insertApiKeyRow(adapter, k) {
  adapter.run(
    `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
  );
}

export function insertComboRow(adapter, c) {
  adapter.run(
    `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
  );
}

export function insertModelAliasRows(adapter, map) {
  for (const [alias, model] of Object.entries(map || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [alias, stringifyJson(model)]);
  }
}

export function insertCustomModelRows(adapter, list) {
  for (const m of list || []) {
    const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
  }
}

export function insertMitmAliasRows(adapter, map) {
  for (const [tool, mappings] of Object.entries(map || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
  }
}

export function insertPricingRows(adapter, map) {
  for (const [provider, models] of Object.entries(map || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
  }
}

// ─── Export ────────────────────────────────────────────────────────────────
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

// ─── Import ────────────────────────────────────────────────────────────────
export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    insertSettingsRow(db, payload.settings);
    for (const c of payload.providerConnections || []) insertConnectionRow(db, c);
    for (const n of payload.providerNodes || []) insertNodeRow(db, n);
    for (const p of payload.proxyPools || []) insertProxyPoolRow(db, p);
    for (const k of payload.apiKeys || []) insertApiKeyRow(db, k);
    for (const c of payload.combos || []) insertComboRow(db, c);
    insertModelAliasRows(db, payload.modelAliases);
    insertCustomModelRows(db, payload.customModels);
    insertMitmAliasRows(db, payload.mitmAlias);
    insertPricingRows(db, payload.pricing);
  });

  return await exportDb();
}
