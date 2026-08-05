import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;

export const statsEmitter = global._statsEmitter;

export function getPendingRequests() {
  return pendingRequests;
}

export function getLastErrorProvider() {
  return lastErrorProvider;
}

export function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      statsEmitter.emit("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  const t = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  console.log(`[${t}] [PENDING] ${started ? "START" : "END"}${error ? " (ERROR)" : ""} | provider=${provider} | model=${model}`);
  statsEmitter.emit("pending");
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}
