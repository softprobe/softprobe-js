import {
  propagation,
  type BaggageEntry,
  type Context,
} from "@opentelemetry/api";
import {
  BAGGAGE_SESSION_KEY,
  parseMobileSessionId,
  type HttpBodyCaptureOptions,
  type HttpBodyCaptureRoute,
} from "./types.js";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const MAX_ALLOWED_BODY_BYTES = 256 * 1024;
export const REDACTED_LITERAL = "[REDACTED]";

export const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-session-token",
]);

const BUILTIN_SENSITIVE_JSON_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api_key",
  "x-api-key",
  "password",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "cardnumber",
  "card_number",
  "cvv",
  "cvc",
]);

export type PathSegment =
  | { readonly kind: "prop"; readonly name: string }
  | { readonly kind: "wildcard" };

export interface CompiledRouteRule {
  readonly origin?: string;
  readonly method: string;
  readonly path: string;
  readonly urlTemplate?: string;
  readonly pathRegex?: RegExp;
  readonly redactPaths: readonly (readonly PathSegment[])[];
}

export interface NormalizedBodyCaptureConfig {
  readonly maxBodyBytes: number;
  readonly captureAllRoutes: boolean;
  readonly routes: readonly CompiledRouteRule[];
  readonly globalRedactPaths: readonly (readonly PathSegment[])[];
}

export function parseJsonPathSegments(rawPath: string): PathSegment[] | null {
  let cursor = rawPath.trim();
  if (!cursor) return null;
  if (cursor.startsWith("$")) {
    cursor = cursor.slice(1);
  }
  const segments: PathSegment[] = [];
  while (cursor.length > 0) {
    if (cursor.startsWith(".")) {
      cursor = cursor.slice(1);
    }
    if (cursor.length === 0) break;

    if (cursor.startsWith("[*]")) {
      segments.push({ kind: "wildcard" });
      cursor = cursor.slice(3);
      continue;
    }

    const bracketMatch = /^\[['"]?([^'"\]]+)['"]?\]/.exec(cursor);
    if (bracketMatch?.[1]) {
      segments.push({ kind: "prop", name: bracketMatch[1] });
      cursor = cursor.slice(bracketMatch[0].length);
      continue;
    }

    if (cursor.startsWith("*")) {
      segments.push({ kind: "wildcard" });
      cursor = cursor.slice(1);
      continue;
    }

    const propMatch = /^([^.[\]]+)/.exec(cursor);
    if (!propMatch?.[1]) return null;
    segments.push({ kind: "prop", name: propMatch[1] });
    cursor = cursor.slice(propMatch[0].length);
  }
  return segments.length > 0 ? segments : null;
}

function compileWildcardPathRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${escaped}$`);
}

export function parseHttpOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function inferAmbientOrigin(
  explicitBaseOrigin: string | undefined,
): string | undefined {
  const explicit = parseHttpOrigin(explicitBaseOrigin);
  if (explicit) return explicit;
  if (typeof globalThis.location?.origin === "string") {
    return parseHttpOrigin(globalThis.location.origin);
  }
  return undefined;
}

export function resolveHttpUrl(
  rawUrl: string,
  baseOrigin: string | undefined,
): URL | null {
  if (!rawUrl) return null;
  try {
    const parsed = baseOrigin ? new URL(rawUrl, baseOrigin) : new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function compileOriginAllowlist(
  apiOrigins: readonly string[] | undefined,
): Set<string> | null {
  if (!apiOrigins || apiOrigins.length === 0) return null;
  return new Set(
    apiOrigins
      .map(parseHttpOrigin)
      .filter((item): item is string => item !== undefined),
  );
}

export function normalizeBodyCapture(
  option: boolean | HttpBodyCaptureOptions | undefined,
  topLevelRedactPaths: readonly string[] | undefined,
): NormalizedBodyCaptureConfig | null {
  if (option === false) return null;
  const resolved: HttpBodyCaptureOptions =
    option === undefined || option === true ? {} : option;
  const maxBodyBytes = Math.min(
    MAX_ALLOWED_BODY_BYTES,
    Math.max(1, Math.trunc(resolved.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)),
  );

  const rawGlobalPaths = [
    ...(topLevelRedactPaths ?? []),
    ...(resolved.redactJsonPaths ?? []),
  ];
  const globalRedactPaths = rawGlobalPaths
    .map(parseJsonPathSegments)
    .filter((item): item is PathSegment[] => item !== null);

  if (!resolved.routes) {
    return {
      maxBodyBytes,
      captureAllRoutes: true,
      routes: [],
      globalRedactPaths,
    };
  }

  const compiledRoutes: CompiledRouteRule[] = [];
  for (const route of resolved.routes) {
    const rule = compileRouteRule(route);
    if (rule) compiledRoutes.push(rule);
  }
  if (compiledRoutes.length === 0) return null;

  return {
    maxBodyBytes,
    captureAllRoutes: false,
    routes: compiledRoutes,
    globalRedactPaths,
  };
}

function compileRouteRule(route: HttpBodyCaptureRoute): CompiledRouteRule | null {
  const method = route.method.trim().toUpperCase();
  if (!method) return null;
  const rawPath = route.path.trim();
  if (!rawPath) return null;

  let origin = parseHttpOrigin(route.origin);
  let pathname = rawPath;
  if (/^https?:\/\//i.test(rawPath)) {
    try {
      const parsed = new URL(rawPath);
      origin = origin ?? parsed.origin;
      pathname = parsed.pathname || "/";
    } catch {
      return null;
    }
  } else if (!pathname.startsWith("/")) {
    pathname = `/${pathname}`;
  }

  const redactPaths = (route.redactJsonPaths ?? [])
    .map(parseJsonPathSegments)
    .filter((item): item is PathSegment[] => item !== null);

  const hasWildcard = pathname.includes("*");
  return {
    ...(origin ? { origin } : {}),
    method,
    path: pathname,
    ...(hasWildcard
      ? {
          urlTemplate: pathname,
          pathRegex: compileWildcardPathRegex(pathname),
        }
      : {}),
    redactPaths,
  };
}

export function matchCaptureRoute(
  config: NormalizedBodyCaptureConfig,
  method: string,
  parsedUrl: URL,
): {
  readonly urlTemplate?: string;
  readonly redactPaths: readonly (readonly PathSegment[])[];
} | null {
  if (config.captureAllRoutes) {
    return { redactPaths: config.globalRedactPaths };
  }
  for (const route of config.routes) {
    if (route.method !== "*" && route.method !== method) continue;
    if (route.origin && route.origin !== parsedUrl.origin) continue;
    const matchesPath = route.pathRegex
      ? route.pathRegex.test(parsedUrl.pathname)
      : route.path === parsedUrl.pathname;
    if (matchesPath) {
      return {
        ...(route.urlTemplate ? { urlTemplate: route.urlTemplate } : {}),
        redactPaths: [...config.globalRedactPaths, ...route.redactPaths],
      };
    }
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readSpanSessionAttribute(span: object): unknown {
  if ("attributes" in span && isPlainRecord(span.attributes)) {
    return span.attributes["sp.session.id"];
  }
  return undefined;
}

function applyPathRedaction(
  node: unknown,
  segments: readonly PathSegment[],
  depth: number,
): unknown {
  const current = segments[depth];
  if (!current) return node;
  const isTerminal = depth === segments.length - 1;

  if (Array.isArray(node)) {
    if (current.kind === "wildcard") {
      return node.map((item) =>
        isTerminal ? REDACTED_LITERAL : applyPathRedaction(item, segments, depth + 1),
      );
    }
    return node.map((item) => applyPathRedaction(item, segments, depth));
  }

  if (!isPlainRecord(node)) return node;
  const out: Record<string, unknown> = { ...node };
  if (current.kind === "wildcard") {
    for (const key of Object.keys(out)) {
      out[key] = isTerminal
        ? REDACTED_LITERAL
        : applyPathRedaction(out[key], segments, depth + 1);
    }
    return out;
  }

  if (Object.prototype.hasOwnProperty.call(out, current.name)) {
    out[current.name] = isTerminal
      ? REDACTED_LITERAL
      : applyPathRedaction(out[current.name], segments, depth + 1);
  }
  return out;
}

function scrubSensitiveJsonKeys(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(scrubSensitiveJsonKeys);
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node)) {
      if (BUILTIN_SENSITIVE_JSON_KEYS.has(key.trim().toLowerCase())) {
        out[key] = REDACTED_LITERAL;
      } else {
        out[key] = scrubSensitiveJsonKeys(val);
      }
    }
    return out;
  }
  return node;
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

export function sanitizeJsonBodyText(
  rawText: string | undefined,
  maxBodyBytes: number,
  redactPaths: readonly (readonly PathSegment[])[],
): string | undefined {
  if (rawText === undefined) return undefined;
  const trimmed = rawText.trim();
  if (!trimmed) return undefined;
  if (utf8ByteLength(trimmed) > maxBodyBytes) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

  try {
    let parsed: unknown = JSON.parse(trimmed);
    parsed = scrubSensitiveJsonKeys(parsed);
    for (const pathRule of redactPaths) {
      parsed = applyPathRedaction(parsed, pathRule, 0);
    }
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

export function mergeBaggageWithSession(
  existingHeader: string | null,
  activeCtx: Context,
  sessionId: string | undefined,
): string | undefined {
  const valuesByKey = new Map<string, string>();

  if (existingHeader) {
    for (const part of existingHeader.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key) valuesByKey.set(key, trimmed);
    }
  }

  const ctxBaggage = propagation.getBaggage(activeCtx);
  if (ctxBaggage) {
    for (const [key, entry] of ctxBaggage.getAllEntries()) {
      if (!valuesByKey.has(key)) {
        valuesByKey.set(key, `${key}=${encodeURIComponent(entry.value)}`);
      }
    }
  }

  const validSession = parseMobileSessionId(sessionId);
  if (validSession) {
    valuesByKey.set(BAGGAGE_SESSION_KEY, `${BAGGAGE_SESSION_KEY}=${validSession}`);
  }

  if (valuesByKey.size === 0) return undefined;
  return [...valuesByKey.values()].join(",");
}

export function contextWithSessionBaggage(
  baseCtx: Context,
  sessionId: string | undefined,
): Context {
  const valid = parseMobileSessionId(sessionId);
  if (!valid) return baseCtx;
  const existing = propagation.getBaggage(baseCtx);
  const entries: Record<string, BaggageEntry> = {};
  if (existing) {
    for (const [k, v] of existing.getAllEntries()) {
      entries[k] = v;
    }
  }
  entries[BAGGAGE_SESSION_KEY] = { value: valid };
  return propagation.setBaggage(baseCtx, propagation.createBaggage(entries));
}

export function scrubHeaderEntries(
  entries: Iterable<readonly [string, string]>,
): string | undefined {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    out[lower] = SENSITIVE_HEADER_NAMES.has(lower) ? REDACTED_LITERAL : value;
    count += 1;
  }
  return count > 0 ? JSON.stringify(out) : undefined;
}

export function isIgnoredUrl(
  href: string,
  ignoreRules: readonly (string | RegExp)[] | undefined,
): boolean {
  if (!ignoreRules || ignoreRules.length === 0) return false;
  for (const rule of ignoreRules) {
    if (typeof rule === "string") {
      if (href === rule || href.startsWith(rule)) return true;
    } else if (rule.test(href)) {
      return true;
    }
  }
  return false;
}
