import type { JsonValue } from "./types.js";

const DEFAULT_REDACT_KEYS = [
  "password",
  "api_key",
  "authorization",
  "secret",
  "token",
];

export function defaultRedactKeys(): string[] {
  return [...DEFAULT_REDACT_KEYS];
}

export function redactValue(
  value: JsonValue,
  redactKeys: string[],
  placeholder = "[REDACTED]",
): JsonValue {
  const keySet = new Set(redactKeys.map((key) => key.toLowerCase()));
  return walk(value, keySet, placeholder);
}

function walk(
  value: JsonValue,
  keySet: Set<string>,
  placeholder: string,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, keySet, placeholder));
  }
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = keySet.has(key.toLowerCase())
        ? placeholder
        : walk(nested, keySet, placeholder);
    }
    return out;
  }
  return value;
}

export function serializeCaptured(
  value: JsonValue | undefined,
  redactKeys: string[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(redactValue(value, redactKeys));
}
