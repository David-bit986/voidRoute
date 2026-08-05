import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic check-then-insert inside transaction to prevent duplicate races
export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT 1 FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) return;
    const value = stringifyJson({ providerAlias, id, type, name: name || id });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

/**
 * Rename a custom provider's model prefix across stored aliases.
 * - customModels scope: keys are `${providerAlias}|${id}|${type}`; rows whose
 *   providerAlias equals the old prefix are re-keyed and rewritten.
 * - modelAliases scope: values are model strings; entries referencing the old
 *   prefix (`old/<model>` or exactly `old`) are rewritten to the new prefix.
 * Runs atomically in a single transaction. Returns a summary of rows moved.
 */
export async function renameCustomModelAlias(oldPrefix, newPrefix, adapter = null) {
  if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) {
    return { renamedModels: 0, renamedAliases: 0 };
  }
  const db = adapter || await getAdapter();
  let renamedModels = 0;
  let renamedAliases = 0;
  db.transaction(() => {
    const customRows = db.all("SELECT key, value FROM kv WHERE scope = 'customModels'");
    for (const row of customRows) {
      const obj = parseJson(row.value, null);
      if (!obj || obj.providerAlias !== oldPrefix) continue;
      const newKey = customKey(newPrefix, obj.id, obj.type || "llm");
      const newValue = stringifyJson({ ...obj, providerAlias: newPrefix });
      db.run("DELETE FROM kv WHERE scope = 'customModels' AND key = ?", [row.key]);
      db.run(
        "INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?) " +
          "ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        [newKey, newValue],
      );
      renamedModels += 1;
    }

    const aliasRows = db.all("SELECT key, value FROM kv WHERE scope = 'modelAliases'");
    for (const row of aliasRows) {
      const value = parseJson(row.value, null);
      if (typeof value !== "string") continue;
      if (value !== oldPrefix && !value.startsWith(`${oldPrefix}/`)) continue;
      const newValue = value === oldPrefix
        ? newPrefix
        : `${newPrefix}${value.slice(oldPrefix.length)}`;
      db.run(
        "UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = ?",
        [stringifyJson(newValue), row.key],
      );
      renamedAliases += 1;
    }
  });
  return { renamedModels, renamedAliases };
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
