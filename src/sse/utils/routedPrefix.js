import { getProviderNodes } from "#lib/db/index.js";

// Providers that are user-registered nodes (custom openai/anthropic-compatible
// endpoints and custom embedding endpoints). Their "alias" is the node prefix,
// not the long node id stored in the connections table.
const NODE_PROVIDER_PREFIXES = ["openai-compatible-", "anthropic-compatible-", "custom-embedding-"];

export function isCustomNodeProvider(providerId) {
  return typeof providerId === "string" && NODE_PROVIDER_PREFIXES.some((prefix) => providerId.startsWith(prefix));
}

/**
 * Resolve the short routed prefix for a custom node provider (e.g. `B.ai` for
 * `openai-compatible-b-ai-6b121aac`). Non-node providers return null so the
 * caller can fall back to the static alias.
 */
export async function resolveRoutedPrefix(providerId, nodes = null) {
  if (!isCustomNodeProvider(providerId)) return null;
  if (!nodes) nodes = await getProviderNodes();
  const node = nodes.find((n) => n.id === providerId);
  return node && (node.prefix || node.name) ? node.prefix || node.name : null;
}