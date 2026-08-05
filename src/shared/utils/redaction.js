export const REDACTED_SECRET = '[REDACTED]';

const SECRET_VALUE_PATTERNS = [
  [/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED_SECRET}`],
  [/\b(sk-[A-Za-z0-9][A-Za-z0-9._-]{6,})\b/g, REDACTED_SECRET],
  [/((?:api[_-]?key|x-api-key|x-opencodex-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie)=)([^&\s"',;]+)/gi, `$1${REDACTED_SECRET}`],
  [/("(?:api[_-]?key|x-api-key|x-opencodex-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|cookie)"\s*:\s*")([^"]+)(")/gi, `$1${REDACTED_SECRET}$3`],
];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  return normalized === 'authorization'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized === 'xapikey'
    || normalized === 'xopencodexapikey'
    || normalized === 'apikey'
    || normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('apikey')
    || (normalized.includes('token') && !normalized.includes('tokens'));
}

export function redactSecretString(value) {
  let redacted = String(value);
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function redactSensitiveData(value) {
  if (typeof value === 'string') return redactSecretString(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item));
  if (!isPlainObject(value)) return value;

  const result = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED_SECRET : redactSensitiveData(entryValue);
  }
  return result;
}

export function redactHeaders(headers) {
  if (!headers) return {};
  const entries = typeof headers.entries === 'function'
    ? headers.entries()
    : Object.entries(headers);
  const result = {};

  for (const [rawKey, rawValue] of entries) {
    if (rawValue === undefined) continue;
    const key = String(rawKey).toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    result[key] = isSensitiveKey(key) ? REDACTED_SECRET : redactSecretString(value);
  }
  return result;
}
