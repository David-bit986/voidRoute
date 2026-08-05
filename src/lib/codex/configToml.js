const MANAGED_ROOT_KEYS = new Set([
  "model",
  "model_provider",
  "model_catalog_json",
]);
const MANAGED_PROVIDER_HEADER = "[model_providers.voidRoute]";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function isTableHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line);
}

function rootAssignmentKey(line) {
  const match = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
  return match?.[1];
}

function parseTomlString(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    const match = /^("(?:\\.|[^"\\])*")/.exec(trimmed);
    if (!match) return undefined;
    try {
      return JSON.parse(match[1]);
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end === -1 ? undefined : trimmed.slice(1, end);
  }
  return undefined;
}

export function readCodexRootValues(source) {
  const values = {};

  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    if (isTableHeader(line)) {
      break;
    }
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match || !MANAGED_ROOT_KEYS.has(match[1])) {
      continue;
    }
    const value = parseTomlString(match[2]);
    if (value !== undefined) {
      values[match[1]] = value;
    }
  }

  return values;
}

function removeManagedProviderBlock(lines) {
  const output = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === MANAGED_PROVIDER_HEADER) {
      skipping = true;
      continue;
    }
    if (skipping && isTableHeader(line)) {
      skipping = false;
    }
    if (!skipping) {
      output.push(line);
    }
  }

  while (output.at(-1) === "") {
    output.pop();
  }
  return output;
}

export function injectCodexConfig(source, { model, catalogPath, baseUrl }) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replace(/\r\n/g, "\n");
  const withoutProvider = removeManagedProviderBlock(normalized.split("\n"));
  const firstTableIndex = withoutProvider.findIndex(isTableHeader);
  const rootEnd = firstTableIndex === -1 ? withoutProvider.length : firstTableIndex;
  const root = withoutProvider
    .slice(0, rootEnd)
    .filter((line) => !MANAGED_ROOT_KEYS.has(rootAssignmentKey(line)));
  while (root.at(-1) === "") {
    root.pop();
  }

  const tables = withoutProvider.slice(rootEnd);
  while (tables.at(-1) === "") {
    tables.pop();
  }

  const output = [
    ...root,
    `model = ${tomlString(model)}`,
    'model_provider = "voidRoute"',
    `model_catalog_json = ${tomlString(catalogPath)}`,
  ];
  if (tables.length > 0) {
    output.push("", ...tables);
  }
  output.push(
    "",
    MANAGED_PROVIDER_HEADER,
    'name = "voidRoute"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  );

  return output.join(eol);
}

export function cleanLegacyCodexAuth(source) {
  let auth;
  try {
    auth = JSON.parse(source);
  } catch {
    return { changed: false, content: source };
  }

  if (
    auth?.auth_mode !== "apikey" ||
    auth?.OPENAI_API_KEY !== "sk_voidRoute"
  ) {
    return { changed: false, content: source };
  }

  delete auth.auth_mode;
  delete auth.OPENAI_API_KEY;
  return {
    changed: true,
    content: `${JSON.stringify(auth, null, 2)}\n`,
  };
}
