import { makeKv, KV_DELETE } from "../helpers/kvStore.js";

const disabledKv = makeKv("disabledModels");

export async function getDisabledModels() {
  return await disabledKv.getAll([]);
}

export async function getDisabledByProvider(providerAlias) {
  const list = await disabledKv.get(providerAlias, []);
  return list || [];
}

export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  await disabledKv.merge(providerAlias, (current) => {
    return [...new Set([...(current || []), ...ids])];
  }, []);
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  if (!Array.isArray(ids) || ids.length === 0) {
    await disabledKv.remove(providerAlias);
    return;
  }
  const removeSet = new Set(ids);
  await disabledKv.merge(providerAlias, (current) => {
    const next = (current || []).filter((id) => !removeSet.has(id));
    return next.length === 0 ? KV_DELETE : next;
  }, []);
}
