// Authoritative provider-alias resolution.
//
// Every module that maps an alias to a provider id (or a provider id back to a
// display alias) must go through this module. Previously three parallel maps
// existed and drifted: open-sse/services/model.js, src/shared/constants/providers.js,
// and open-sse/config/providerModels.js. All three now delegate here.

import { PROVIDERS } from "#open-sse/config/providers.js";

// ─── Alias → provider id (routing) ──────────────────────────────────────────
// The authoritative resolution map. Superset of every registry in the codebase.
export const ALIAS_TO_PROVIDER_ID = {
  cc: "claude",
  cx: "codex",
  gc: "gemini-cli",
  qw: "qwen",
  if: "iflow",
  ag: "antigravity",
  gh: "github",
  kr: "kiro",
  cu: "cursor",
  kc: "kilocode",
  kmc: "kimi-coding",
  cl: "cline",
  oc: "opencode",
  ocg: "opencode-go",
  // TTS providers
  el: "elevenlabs",
  // API Key providers
  openai: "openai",
  vercel: "vercel-ai-gateway",
  "vercel-ai-gateway": "vercel-ai-gateway",
  anthropic: "anthropic",
  gemini: "gemini",
  google: "gemini",
  "google-gemini": "gemini",
  openrouter: "openrouter",
  glm: "glm",
  zai: "zai",
  "z.ai": "zai",
  kimi: "kimi",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  ds: "deepseek",
  deepseek: "deepseek",
  cmc: "commandcode",
  commandcode: "commandcode",
  groq: "groq",
  xai: "xai",
  mistral: "mistral",
  pplx: "perplexity",
  perplexity: "perplexity",
  together: "together",
  fireworks: "fireworks",
  cerebras: "cerebras",
  cohere: "cohere",
  nvidia: "nvidia",
  nebius: "nebius",
  siliconflow: "siliconflow",
  hyp: "hyperbolic",
  hyperbolic: "hyperbolic",
  dg: "deepgram",
  deepgram: "deepgram",
  aai: "assemblyai",
  assemblyai: "assemblyai",
  nb: "nanobanana",
  nanobanana: "nanobanana",
  ch: "chutes",
  chutes: "chutes",
  ark: "volcengine-ark",
  "volcengine-ark": "volcengine-ark",
  byteplus: "byteplus",
  bpm: "byteplus",
  cursor: "cursor",
  vx: "vertex",
  vertex: "vertex",
  vxp: "vertex-partner",
  "vertex-partner": "vertex-partner",
  // Web cookie providers
  gw: "grok-web",
  "grok-web": "grok-web",
  pw: "perplexity-web",
  "perplexity-web": "perplexity-web",
  mimo: "xiaomi-mimo",
  "xiaomi-mimo": "xiaomi-mimo",
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
  cf: "cloudflare-ai",
  "cloudflare-ai": "cloudflare-ai",
  // Image/video providers
  fal: "fal-ai",
  "fal-ai": "fal-ai",
  stability: "stability-ai",
  "stability-ai": "stability-ai",
  bfl: "black-forest-labs",
  "black-forest-labs": "black-forest-labs",
  recraft: "recraft",
  topaz: "topaz",
  runway: "runwayml",
  runwayml: "runwayml",
  // Embedding/rerank
  jina: "jina-ai",
  "jina-ai": "jina-ai",
  // TTS
  polly: "aws-polly",
  "aws-polly": "aws-polly",
  // Free-tier providers (synced from OmniRoute)
  agentrouter: "agentrouter",
  aimlapi: "aimlapi",
  aiml: "aimlapi",
  novita: "novita",
  modal: "modal",
  mdl: "modal",
  reka: "reka",
  nlpcloud: "nlpcloud",
  nlpc: "nlpcloud",
  bazaarlink: "bazaarlink",
  bzl: "bazaarlink",
  completions: "completions",
  cpl: "completions",
  enally: "enally",
  enly: "enally",
  freetheai: "freetheai",
  fta: "freetheai",
  llm7: "llm7",
  lepton: "lepton",
  kluster: "kluster",
  ai21: "ai21",
  "inference-net": "inference-net",
  inet: "inference-net",
  predibase: "predibase",
  bytez: "bytez",
  morph: "morph",
  longcat: "longcat",
  lc: "longcat",
  puter: "puter",
  pu: "puter",
  uncloseai: "uncloseai",
  unc: "uncloseai",
  scaleway: "scaleway",
  scw: "scaleway",
  deepinfra: "deepinfra",
  sambanova: "sambanova",
  samba: "sambanova",
  nscale: "nscale",
  baseten: "baseten",
  publicai: "publicai",
  "nous-research": "nous-research",
  nous: "nous-research",
  glhf: "glhf",
  bb: "blackbox",
  blackbox: "blackbox",
};

/** Resolve a provider alias (or id) to a canonical provider id. */
export function resolveProviderAlias(aliasOrId) {
  return ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
}

// ─── Provider id → display alias (listing) ─────────────────────────────────
// OAuth/cookie providers get short aliases; everything else displays its id.
// Preserved from the previous providerModels.js derivation so listing output,
// model metadata lookups, and stored config ids do not change.
const OAUTH_ALIASES = {
  claude: "cc",
  codex: "cx",
  "gemini-cli": "gc",
  qwen: "qw",
  iflow: "if",
  antigravity: "ag",
  github: "gh",
  kiro: "kr",
  cursor: "cu",
  "kimi-coding": "kmc",
  kilocode: "kc",
  cline: "cl",
  opencode: "oc",
  vertex: "vertex",
  "vertex-partner": "vertex-partner",
};

export const PROVIDER_ID_TO_ALIAS = Object.fromEntries(
  Object.keys(PROVIDERS).map((id) => [id, OAUTH_ALIASES[id] || id])
);

/** Get the display alias for a provider id (fallback: the id itself). */
export function getProviderAlias(providerId) {
  return PROVIDER_ID_TO_ALIAS[providerId] || providerId;
}

// Compat names used by the web UI constants module.
export const ALIAS_TO_ID = ALIAS_TO_PROVIDER_ID;
export const ID_TO_ALIAS = PROVIDER_ID_TO_ALIAS;
