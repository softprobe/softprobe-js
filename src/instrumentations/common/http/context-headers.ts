/**
 * Shared HTTP header helpers for instrumentation packages.
 */
export type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * Returns a normalized lower-case header map from mixed-case input keys.
 */
export function normalizeHeaderMap(headers: HeaderMap | undefined): HeaderMap {
  if (!headers) return {};
  const normalized: HeaderMap = {};

  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }

  return normalized;
}
