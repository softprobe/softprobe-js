import type { HttpBodyCaptureOptions } from "./types.js";

export const PRODUCTION_THELAKE_BASE_URL = "https://explorer.softprobe.ai/api/thelake";

export const BUILTIN_JSON_PROPERTY_REDACTIONS: readonly string[] = [
  "cardNumber",
  "cvv",
  "cvc",
  "password",
  "secret",
];

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const REDACTED_VALUE = "[REDACTED]";

export type HttpCaptureRoute = {
  origin: string;
  method: string;
  path: string;
  extraRedactionPaths: string[][];
};

export type HttpCapturePlan = {
  maxBodyBytes: number;
  builtinPropertyRedactions: readonly string[];
  routes: Map<string, HttpCaptureRoute>;
};

export function resolveInitBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return PRODUCTION_THELAKE_BASE_URL;
  return baseUrl;
}

export function parseExactHttpOrigin(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function httpCaptureRouteKey(origin: string, method: string, path: string): string {
  return `${origin}\n${method}\n${path}`;
}

export function compileHttpCapture(
  options: HttpBodyCaptureOptions | undefined,
  origins: ReadonlySet<string>,
): HttpCapturePlan | null {
  if (!options || !Array.isArray(options.routes)) return null;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > MAX_BODY_BYTES) {
    return null;
  }

  const routes = new Map<string, HttpCaptureRoute>();
  for (const candidate of options.routes) {
    const route = compileRoute(candidate, origins);
    if (!route) continue;
    routes.set(httpCaptureRouteKey(route.origin, route.method, route.path), route);
  }
  if (routes.size === 0) return null;
  return {
    maxBodyBytes,
    builtinPropertyRedactions: BUILTIN_JSON_PROPERTY_REDACTIONS,
    routes,
  };
}

export function redactParsedJson(
  value: unknown,
  propertyNames: readonly string[],
  extraPaths: readonly string[][],
): void {
  if (Array.isArray(value)) {
    for (const item of value) redactParsedJson(item, propertyNames, []);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    const completesExtraPath = extraPaths.some((path) => path.length === 1 && path[0] === key);
    if (propertyNames.includes(key) || completesExtraPath) {
      value[key] = REDACTED_VALUE;
      continue;
    }
    const continued: string[][] = [];
    for (const path of extraPaths) {
      if (path.length > 1 && path[0] === key) continued.push(path.slice(1));
    }
    redactParsedJson(value[key], propertyNames, continued);
  }
}

function compileRoute(candidate: unknown, origins: ReadonlySet<string>): HttpCaptureRoute | null {
  if (!isPlainObject(candidate)) return null;
  const method = typeof candidate.method === "string" ? candidate.method.trim().toUpperCase() : "";
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!/^[A-Z]+$/.test(method) || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
    return null;
  }

  const origin = routeOrigin(candidate.origin, origins);
  if (!origin) return null;
  const extraRedactionPaths = parseExtraRedactionPaths(candidate.redactJsonPaths);
  if (!extraRedactionPaths) return null;
  return { origin, method, path, extraRedactionPaths };
}

function routeOrigin(value: unknown, origins: ReadonlySet<string>): string | null {
  if (value === undefined) {
    if (origins.size !== 1) return null;
    const only = origins.values().next().value;
    return typeof only === "string" ? only : null;
  }
  if (typeof value !== "string") return null;
  const parsed = parseExactHttpOrigin(value);
  if (!parsed || !origins.has(parsed)) return null;
  return parsed;
}

function parseExtraRedactionPaths(value: unknown): string[][] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const parsed: string[][] = [];
  for (const entry of value) {
    const segments = parseRedactionPath(entry);
    if (!segments) return null;
    parsed.push(segments);
  }
  return parsed;
}

function parseRedactionPath(path: unknown): string[] | null {
  if (typeof path !== "string" || !path.startsWith("$.")) return null;
  const parts = path.slice(2).split(".");
  if (parts.length === 0 || parts.some((part) =>
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) ||
    part === "__proto__" || part === "prototype" || part === "constructor"
  )) return null;
  return parts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
