import { PROVIDERS as PROVIDER_ENDPOINTS } from '#open-sse/config/providers.js';
import { CLIENT_METADATA, getPlatformUserAgent } from '#open-sse/config/appConstants.js';
import {
  PROVIDER_MODELS,
  PROVIDER_ID_TO_ALIAS,
  setSyncedModels,
  clearAllSyncedModels,
} from '#open-sse/config/providerModels.js';
import { getProviderConnections, getSettings, updateSettings } from './db/index.js';

// ─── Live model fetch per provider ─────────────────────────────────────────
// Same logic historically lived in cli-ui.js; kept here so the settings
// "Refresh Models" action and combo auto-detect share one implementation.
// OAuth openai-compatible providers that can refresh their access token
// before hitting /models (qwen, iflow, xai).
const GENERIC_REFRESH_PROVIDERS = new Set(['qwen', 'iflow', 'xai']);
export async function fetchProviderModels(providerId, conn) {
  if (!conn) return [];
  try {
    let url = '';
    let method = 'GET';
    let body = null;
    let headers = { 'Accept': 'application/json' };

    if (providerId === 'openai') {
      url = 'https://api.openai.com/v1/models';
      headers['Authorization'] = `Bearer ${conn.apiKey}`;
    } else if (providerId === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/models';
      if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`;
    } else if (providerId === 'deepseek') {
      url = 'https://api.deepseek.com/models';
      headers['Authorization'] = `Bearer ${conn.apiKey}`;
    } else if (providerId === 'siliconflow') {
      url = 'https://api.siliconflow.cn/v1/models';
      headers['Authorization'] = `Bearer ${conn.apiKey}`;
    } else if (providerId === 'groq') {
      url = 'https://api.groq.com/openai/v1/models';
      headers['Authorization'] = `Bearer ${conn.apiKey}`;
    } else if (providerId === 'together') {
      url = 'https://api.together.xyz/v1/models';
      headers['Authorization'] = `Bearer ${conn.apiKey}`;
    } else if (providerId === 'gemini') {
      const key = conn.apiKey || conn.accessToken;
      if (key) {
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
      }
    } else if (providerId === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models';
      headers['x-api-key'] = conn.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (providerId === 'ollama') {
      url = 'http://localhost:11434/api/tags';
    } else if (providerId === 'mistral') {
      url = 'https://api.mistral.ai/v1/models';
      headers['Authorization'] = `Bearer ${conn.apiKey}`;
    } else if (providerId === 'antigravity' || providerId === 'gemini-cli') {
      let token = conn.accessToken;
      if (conn.refreshToken) {
        try {
          const { getAccessToken } = await import('#open-sse/services/tokenRefresh.js');
          const fresh = await getAccessToken(providerId, conn);
          if (fresh?.accessToken) token = fresh.accessToken;
        } catch { /* fall back to stored token */ }
      }
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        headers['User-Agent'] = getPlatformUserAgent();
        headers['X-Client-Name'] = 'antigravity';
        headers['X-Client-Version'] = '1.107.0';
        headers['x-request-source'] = 'local';
        headers['Content-Type'] = 'application/json';
        url = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
        method = 'POST';
        let projectId = conn.projectId || conn.providerSpecificData?.projectId || null;
        if (!projectId) {
          try {
            const sub = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': getPlatformUserAgent(),
                'x-request-source': 'local',
              },
              body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
              signal: AbortSignal.timeout(5000),
            });
            if (sub.ok) {
              const subData = await sub.json();
              projectId = subData.cloudaicompanionProject || null;
            }
          } catch { /* project id is optional */ }
        }
        body = JSON.stringify(projectId ? { project: projectId } : {});
      }
    } else if (providerId === 'github') {
      const ghAccessToken = conn.accessToken;
      if (ghAccessToken) {
        try {
          const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
            headers: {
              'Authorization': `token ${ghAccessToken}`,
              'User-Agent': 'GitHubCopilotChat/0.38.0',
              'Editor-Version': 'vscode/1.110.0',
              'Editor-Plugin-Version': 'copilot-chat/0.38.0',
              'Accept': 'application/json',
              'x-github-api-version': '2025-04-01',
            },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.token) {
              url = 'https://api.githubcopilot.com/models';
              headers['Authorization'] = `Bearer ${data.token}`;
              headers['copilot-integration-id'] = 'vscode-chat';
              headers['editor-version'] = 'vscode/1.110.0';
              headers['editor-plugin-version'] = 'copilot-chat/0.38.0';
              headers['user-agent'] = 'GitHubCopilotChat/0.38.0';
              headers['x-github-api-version'] = '2025-04-01';
            }
          }
        } catch { /* no copilot token */ }
      }
    } else if (providerId === 'kiro') {
      const { resolveKiroModels } = await import('#open-sse/services/kiroModels.js');
      let creds = conn;
      if (conn.refreshToken) {
        try {
          const { getAccessToken } = await import('#open-sse/services/tokenRefresh.js');
          const fresh = await getAccessToken('kiro', conn);
          if (fresh?.accessToken) creds = { ...conn, ...fresh };
        } catch { /* fall back to stored token */ }
      }
      const result = await resolveKiroModels(creds);
      if (result) {
        return result.models.map(m => ({ id: m.id, name: m.name }));
      }
    } else if (providerId === 'opencode') {
      url = 'https://opencode.ai/zen/v1/models';
    } else {
      const definition = PROVIDER_ENDPOINTS[providerId];
      let base = '';
      if (definition && definition.baseUrl) {
        base = definition.baseUrl;
      } else if (providerId.startsWith('openai-compatible-')) {
        const { getProviderNodeById } = await import('./db/index.js');
        const node = await getProviderNodeById(providerId);
        if (node && node.baseUrl) {
          base = node.baseUrl;
        }
      } else if (conn?.providerSpecificData?.baseUrl) {
        base = conn.providerSpecificData.baseUrl;
      }

      if (base) {
        if (base.endsWith('/chat/completions')) {
          base = base.replace(/\/chat\/completions$/, '');
        } else if (base.endsWith('/messages')) {
          base = base.replace(/\/messages$/, '');
        }

        if (base.endsWith('/v1')) {
          url = `${base}/models`;
        } else if (base.includes('/v1/')) {
          url = base.split('/v1/')[0] + '/v1/models';
    } else if (providerId === 'kimi-coding') {
      let token = conn.accessToken;
      if (conn.refreshToken) {
        try {
          const { buildKimiHeaders } = await import('#open-sse/config/appConstants.js');
          const res = await fetch('https://auth.kimi.com/api/oauth/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json',
              ...buildKimiHeaders(),
            },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: conn.refreshToken,
              client_id: '17e5f671-d194-4dfb-9706-5516cb48c098',
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const tokens = await res.json();
            if (tokens.access_token) token = tokens.access_token;
          }
        } catch { /* fall back to stored token */ }
      }
      if (token) {
        url = 'https://api.kimi.com/coding/v1/models';
        headers['Authorization'] = `Bearer ${token}`;
      }
    } else {
          url = `${base}/models`;
        }

        let token = conn.apiKey && conn.apiKey !== 'local-no-key' ? conn.apiKey : conn.accessToken;
        if (!token && conn.refreshToken && GENERIC_REFRESH_PROVIDERS.has(providerId)) {
          try {
            const { getAccessToken } = await import('#open-sse/services/tokenRefresh.js');
            const fresh = await getAccessToken(providerId, conn);
            if (fresh?.accessToken) token = fresh.accessToken;
          } catch { /* fall back to stored token */ }
        }
        if (token) headers['Authorization'] = `Bearer ${token}`;
      }
    }

    if (!url) return [];

    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return [];
    }

    const data = await res.json();

    if (providerId === 'ollama') {
      if (data && Array.isArray(data.models)) {
        return data.models.map(m => ({ id: m.name, name: m.name }));
      }
    } else if (providerId === 'gemini') {
      if (data && Array.isArray(data.models)) {
        return data.models
          .filter(m => m.name && m.name.startsWith('models/'))
          .map(m => {
            const cleanId = m.name.replace(/^models\//, '');
            return { id: cleanId, name: m.displayName || cleanId };
          });
      }
    } else if (providerId === 'antigravity' || providerId === 'gemini-cli') {
      if (data && data.models && typeof data.models === 'object') {
        return Object.entries(data.models)
          .filter(([key, info]) => info && !info.isInternal && !key.startsWith('tab_'))
          .map(([key, info]) => ({ id: key, name: info.displayName || key }));
      }
    } else if (data && Array.isArray(data.data)) {
      return data.data.map(m => ({ id: m.id, name: m.id }));
    } else if (data && Array.isArray(data)) {
      return data.map(m => (typeof m === 'string' ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id }));
    }

    return [];
  } catch (err) {
    return [];
  }
}

// A static entry is "special" when it carries configuration beyond id/name
// (image/embedding/tts types, upstreamModelId, quotaFamily, capabilities, ...).
// Those are preserved during a sync; only plain {id, name} LLM entries are refreshed.
function isSpecialEntry(m) {
  if (!m) return false;
  return Object.keys(m).some(k => k !== 'id' && k !== 'name');
}

// ─── Sync: fetch live, drop EOL, add new, persist ──────────────────────────
export async function syncProviderModels() {
  const connections = await getProviderConnections({ isActive: true });
  const results = [];
  const overlay = new Map();

  for (const conn of connections) {
    const providerId = conn.provider;
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    const live = await fetchProviderModels(providerId, conn);
    if (!live.length) {
      results.push({ provider: providerId, alias, status: 'skipped', reason: 'no live models returned' });
      continue;
    }

    const staticList = PROVIDER_MODELS[alias] || [];
    const special = staticList.filter(isSpecialEntry);
    const plain = staticList.filter(m => !isSpecialEntry(m));
    const liveById = new Map(live.map(m => [m.id, m]));

    // Guard: don't clobber a curated static list with a mismatched live
    // catalog (e.g. NVIDIA build lists every model, curated static keeps a few).
    // Require a meaningful id overlap unless the static list is empty.
    // Kiro is exempt: its live catalog is authoritative and uses upstream ids
    // that deliberately differ from the curated synthetic ones.
    const SKIP_GUARD_PROVIDERS = new Set(['kiro']);
    if (staticList.length && !SKIP_GUARD_PROVIDERS.has(providerId)) {
      const plainIds = plain.map(m => m.id);
      if (plainIds.length) {
        const overlap = plainIds.filter(id => liveById.has(id)).length;
        if (overlap / plainIds.length < 0.5) {
          results.push({ provider: providerId, alias, status: 'skipped', reason: 'live catalog mismatch (low overlap)' });
          continue;
        }
      }
    }

    const removed = plain.filter(m => !liveById.has(m.id)).map(m => m.id);
    const staticIds = new Set(staticList.map(m => m.id));
    const added = live
      .filter(m => !staticIds.has(m.id))
      .map(m => ({ id: m.id, name: m.name || m.id }));

    const merged = [...special, ...plain.filter(m => liveById.has(m.id)), ...added];
    overlay.set(alias, merged);

    results.push({
      provider: providerId,
      alias,
      status: 'synced',
      total: merged.length,
      added: added.length,
      removed: removed.length,
    });
  }

  if (overlay.size) {
    const settings = await getSettings();
    const next = { ...(settings.modelSync || {}) };
    for (const [alias, models] of overlay) {
      setSyncedModels(alias, models);
      next[alias] = models;
    }
    await updateSettings({ modelSync: next });
  }

  return results;
}

// ─── Startup: re-apply saved overlay so /v1/models & combos stay fresh ──────
export async function hydrateSyncedModels() {
  const settings = await getSettings();
  const modelSync = settings.modelSync || {};
  for (const [alias, models] of Object.entries(modelSync)) {
    if (Array.isArray(models) && models.length) setSyncedModels(alias, models);
  }
}

// ─── Reset: clear overlay + persisted state, back to static config ─────────
export async function resetSyncedModels() {
  clearAllSyncedModels();
  await updateSettings({ modelSync: {} });
}
