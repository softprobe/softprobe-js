/** Keep it simple: ignore body only when content size is explicitly zero. */
export function shouldCaptureBody(body: unknown, bodyBytes?: number): boolean {
  if (bodyBytes === 0) return false;
  return body !== undefined && body !== null;
}

/** Parses content-length from incoming headers; returns undefined for absent/invalid values. */
export function parseContentLengthHeader(
  headers?: Record<string, string | string[] | undefined>
): number | undefined {
  const raw = headers?.['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
