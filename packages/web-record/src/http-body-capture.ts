import {
  context,
  SpanKind,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type {
  FetchCustomAttributeFunction,
  FetchRequestHookFunction,
} from "@opentelemetry/browser-instrumentation/experimental/fetch";
import type {
  HttpBodyCaptureOptions,
  HttpBodyCaptureRoute,
} from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const BUILTIN_JSON_PROPERTY_REDACTIONS = ["cardNumber", "cvv", "cvc", "password", "secret"];
const MAX_BODY_BYTES = 256 * 1024;
const REDACTED_VALUE = "[REDACTED]";
const BODY_SPAN_NAME = "softprobe.http.body.capture";

type NormalizedRoute = {
  origin: string;
  method: string;
  path: string;
  redactionPaths: string[][];
};

type BodyCaptureConfig = {
  maxBodyBytes: number;
  captureAllOnAllowedOrigins: boolean;
  routes: Map<string, NormalizedRoute>;
};

type BodyState = {
  route: NormalizedRoute;
  requestUrl: string;
  requestMethod: string;
  requestBody: Promise<string | undefined>;
  responseBody: Promise<string | undefined>;
  responseStatus?: number;
  discoveredSessionId?: string;
};

type FetchCall = {
  url: string;
  method: string;
  state?: BodyState;
};

type XhrState = {
  route: NormalizedRoute;
  requestUrl: string;
  requestMethod: string;
  contentType: string;
  maxBodyBytes: number;
  requestBody?: string;
  discoveredSessionId?: string;
};

export type HttpBodyCaptureHooks = {
  fetch: {
    requestHook: FetchRequestHookFunction;
    applyCustomAttributesOnSpan: FetchCustomAttributeFunction;
    installObserver: () => void;
  };
  xhr: {
    applyCustomAttributesOnSpan: (span: Span, xhr: XMLHttpRequest) => void;
  };
  dispose: () => void;
};

export function createHttpBodyCaptureHooks(options: {
  apiOrigins?: string[];
  httpBodyCapture?: boolean | HttpBodyCaptureOptions;
  collectorUrl: string;
  getTracer: () => Tracer;
  onSessionId?: (sessionId: string) => void;
}): HttpBodyCaptureHooks {
  const explicitOrigins = normalizeOrigins(options.apiOrigins ?? []);
  const allowedOrigins = new Set(resolveEffectiveOrigins(options.apiOrigins, options.httpBodyCapture));
  const capture = normalizeCaptureOptions(options.httpBodyCapture, explicitOrigins, allowedOrigins);
  const collectorUrl = new URL(options.collectorUrl);
  const fetchStates = new WeakMap<Span, BodyState>();
  const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();
  const fetchCalls: FetchCall[] = [];
  let disposeFetchObserver = (): void => undefined;
  let fetchObserverInstalled = false;
  const disposeXhrObserver = capture
    ? installXhrBodyObserver(xhrStates, capture, allowedOrigins, collectorUrl, options.onSessionId)
    : () => undefined;

  const requestHook: FetchRequestHookFunction = (span, request) => {
    if (!capture) return;
    const call = fetchCalls[fetchCalls.length - 1];
    if (!call || isCollectorUrl(call.url, collectorUrl)) return;
    const route = findRoute(capture, allowedOrigins, call.url, call.method);
    if (!route) return;
    let headers: Headers;
    try {
      headers = new Headers(request.headers);
    } catch {
      headers = new Headers();
    }
    const pathSessionId = options.onSessionId ? extractSessionIdFromPath(route.path) : undefined;
    if (pathSessionId) {
      options.onSessionId?.(pathSessionId);
      applySessionIdToSpan(span, pathSessionId);
    }
    const state: BodyState = {
      route,
      requestUrl: `${route.origin}${route.path}`,
      requestMethod: call.method,
      requestBody: Promise.resolve(undefined),
      responseBody: Promise.resolve(undefined),
      discoveredSessionId: pathSessionId,
    };
    state.requestBody = captureRequestBody(request, headers, route, capture.maxBodyBytes, (discovered) => {
      if (! options.onSessionId) return;
      state.discoveredSessionId = discovered;
      options.onSessionId(discovered);
      applySessionIdToSpan(span, discovered);
    });
    call.state = state;
    fetchStates.set(span, state);
  };

  const applyCustomAttributesOnSpan: FetchCustomAttributeFunction = (span, _request, result) => {
    const state = fetchStates.get(span);
    if (!state || !capture) return;
    fetchStates.delete(span);
    void finishBodySpan(
      span,
      state,
      state.requestBody,
      state.responseBody,
      state.responseStatus,
      options.getTracer,
      options.onSessionId,
    );
  };

  const applyXhrCustomAttributes = (span: Span, xhr: XMLHttpRequest): void => {
    const state = xhrStates.get(xhr);
    if (!state || !capture) return;
    xhrStates.delete(xhr);
    if (state.discoveredSessionId) {
      applySessionIdToSpan(span, state.discoveredSessionId);
    }
    let responseText: string | undefined;
    try {
      if (isJsonContentType(xhr.getResponseHeader("content-type"))) {
        if (xhr.responseType === "json") {
          responseText = JSON.stringify(xhr.response);
        } else if (xhr.responseType === "" || xhr.responseType === "text") {
          responseText = xhr.responseText;
        }
      }
    } catch {
      responseText = undefined;
    }
    const responseBody = Promise.resolve(
      responseText === undefined
        ? undefined
        : sanitizedJsonBody(responseText, state.route, capture.maxBodyBytes, (discovered) => {
            if (!options.onSessionId) return;
            state.discoveredSessionId = discovered;
            options.onSessionId(discovered);
            applySessionIdToSpan(span, discovered);
          }),
    );
    void finishBodySpan(
      span,
      state,
      Promise.resolve(state.requestBody),
      responseBody,
      xhr.status || undefined,
      options.getTracer,
      options.onSessionId,
    );
  };

  return {
    fetch: {
      requestHook,
      applyCustomAttributesOnSpan,
      installObserver: () => {
        if (fetchObserverInstalled || !capture || typeof globalThis.fetch !== "function") return;
        fetchObserverInstalled = true;
        disposeFetchObserver = installFetchBodyObserver(
          fetchCalls,
          capture,
          allowedOrigins,
          collectorUrl,
          options.onSessionId,
        );
      },
    },
    xhr: { applyCustomAttributesOnSpan: applyXhrCustomAttributes },
    dispose: () => {
      disposeFetchObserver();
      disposeXhrObserver();
    },
  };
}

async function finishBodySpan(
  parentSpan: Span,
  state: BodyState | XhrState,
  requestBody: Promise<string | undefined>,
  responseBody: Promise<string | undefined>,
  statusCode: number | undefined,
  getTracer: () => Tracer,
  onSessionId?: (sessionId: string) => void,
): Promise<void> {
  let child: Span | undefined;
  try {
    const parentContext = trace.setSpan(context.active(), parentSpan);
    child = getTracer().startSpan(
      BODY_SPAN_NAME,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "sp.observation.type": "http_body",
          "http.request.method": state.requestMethod,
          "url.full": state.requestUrl,
          ...(statusCode === undefined ? {} : { "http.response.status_code": statusCode }),
        },
      },
      parentContext,
    );
    const [request, response] = await Promise.all([requestBody, responseBody]);
    if (state.discoveredSessionId) {
      onSessionId?.(state.discoveredSessionId);
      applySessionIdToSpan(parentSpan, state.discoveredSessionId);
      applySessionIdToSpan(child, state.discoveredSessionId);
    }
    if (request !== undefined) child.setAttribute("http.request.body.content", request);
    if (response !== undefined) child.setAttribute("http.response.body.content", response);
    child.setAttribute(
      "sp.body.capture.status",
      request === undefined && response === undefined ? "omitted" : "captured",
    );
  } catch {
    // Body capture must never change the application request or response.
  } finally {
    child?.end();
  }
}

function normalizeCaptureOptions(
  options: boolean | HttpBodyCaptureOptions | undefined,
  explicitOrigins: Set<string>,
  allowedOrigins: Set<string>,
): BodyCaptureConfig | null {
  if (!options) return null;
  const resolved: HttpBodyCaptureOptions = options === true ? {} : options;
  const maxBodyBytes = resolved.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > MAX_BODY_BYTES) {
    return null;
  }

  if (resolved.routes === undefined) {
    return allowedOrigins.size > 0
      ? { maxBodyBytes, captureAllOnAllowedOrigins: true, routes: new Map() }
      : null;
  }
  if (!Array.isArray(resolved.routes)) return null;

  const routes = new Map<string, NormalizedRoute>();
  for (const candidate of resolved.routes as HttpBodyCaptureRoute[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const method = typeof candidate.method === "string" ? candidate.method.trim().toUpperCase() : "";
    if (!/^[A-Z]+$/.test(method)) continue;

    const target = parseRouteTarget(candidate, explicitOrigins, allowedOrigins);
    if (!target) continue;

    const redactionPaths = candidate.redactJsonPaths ?? [];
    if (!Array.isArray(redactionPaths)) continue;
    const parsedPaths = redactionPaths.map(parseRedactionPath);
    if (parsedPaths.some((parts) => parts === null)) continue;
    routes.set(routeKey(target.origin, method, target.path), {
      origin: target.origin,
      method,
      path: target.path,
      redactionPaths: parsedPaths as string[][],
    });
  }

  return routes.size ? { maxBodyBytes, captureAllOnAllowedOrigins: false, routes } : null;
}

function parseRouteTarget(
  candidate: HttpBodyCaptureRoute,
  explicitOrigins: Set<string>,
  allowedOrigins: Set<string>,
): { origin: string; path: string } | null {
  const rawPath = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!rawPath || rawPath.includes("?") || rawPath.includes("#")) return null;

  if (rawPath.startsWith("/")) {
    const origin = routeOrigin(candidate.origin, explicitOrigins, allowedOrigins);
    return origin ? { origin, path: rawPath } : null;
  }

  try {
    const parsed = new URL(rawPath);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      !parsed.pathname.startsWith("/") ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    if (candidate.origin !== undefined) {
      const explicitRouteOrigin = parseExactOrigin(candidate.origin);
      if (!explicitRouteOrigin || explicitRouteOrigin !== parsed.origin) return null;
    }
    if (!allowedOrigins.has(parsed.origin)) return null;
    return { origin: parsed.origin, path: parsed.pathname };
  } catch {
    return null;
  }
}

function routeOrigin(
  value: string | undefined,
  explicitOrigins: Set<string>,
  allowedOrigins: Set<string>,
): string | null {
  if (value === undefined) {
    if (explicitOrigins.size === 1) {
      const only = explicitOrigins.values().next().value;
      return typeof only === "string" ? only : null;
    }
    if (explicitOrigins.size > 1) return null;
    const pageOrigin = currentPageOrigin();
    return pageOrigin && allowedOrigins.has(pageOrigin) ? pageOrigin : null;
  }
  const parsedOrigin = parseExactOrigin(value);
  if (!parsedOrigin) return null;
  return allowedOrigins.has(parsedOrigin) ? parsedOrigin : null;
}

export function parseExactOrigin(candidate: string | undefined): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    ) {
      return url.origin;
    }
    return null;
  } catch {
    return null;
  }
}

function parseRouteUrlOrigin(rawPath: string | undefined): string | null {
  if (!rawPath || typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#")) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname.startsWith("/") &&
      !parsed.search &&
      !parsed.hash
    ) {
      return parsed.origin;
    }
    return null;
  } catch {
    return null;
  }
}

export function currentPageOrigin(): string | null {
  if (typeof location === "undefined") return null;
  const fromOrigin = parseExactOrigin(location.origin);
  if (fromOrigin) return fromOrigin;
  try {
    return location.href ? parseExactOrigin(new URL(location.href).origin) : null;
  } catch {
    return null;
  }
}

export function resolveEffectiveOrigins(
  apiOrigins: string[] | undefined,
  httpBodyCapture?: boolean | HttpBodyCaptureOptions,
): string[] {
  const explicitOrigins = normalizeOrigins(apiOrigins ?? []);
  if (explicitOrigins.size > 0) return [...explicitOrigins];

  const derived = new Set<string>();
  const pageOrigin = currentPageOrigin();
  if (pageOrigin) derived.add(pageOrigin);
  const routes = typeof httpBodyCapture === "object" && httpBodyCapture !== null
    ? (httpBodyCapture.routes ?? [])
    : [];
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const explicitRouteOrigin = parseExactOrigin(route.origin);
    if (explicitRouteOrigin) derived.add(explicitRouteOrigin);
    const fullUrlRouteOrigin = parseRouteUrlOrigin(route.path);
    if (fullUrlRouteOrigin) derived.add(fullUrlRouteOrigin);
  }
  return [...derived];
}

function normalizeOrigins(origins: string[]): Set<string> {
  const result = new Set<string>();
  for (const candidate of origins) {
    const origin = parseExactOrigin(candidate);
    if (origin) result.add(origin);
  }
  return result;
}

function findRoute(
  capture: BodyCaptureConfig,
  allowedOrigins: Set<string>,
  rawUrl: string,
  method: string,
): NormalizedRoute | undefined {
  try {
    const url = new URL(rawUrl, typeof location === "undefined" ? undefined : location.href);
    if (!allowedOrigins.has(url.origin)) return undefined;
    const normalizedMethod = method.toUpperCase();
    const matched = capture.routes.get(routeKey(url.origin, normalizedMethod, url.pathname));
    if (matched) return matched;
    if (capture.captureAllOnAllowedOrigins && /^[A-Z]+$/.test(normalizedMethod)) {
      return {
        origin: url.origin,
        method: normalizedMethod,
        path: url.pathname,
        redactionPaths: [],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function routeKey(origin: string, method: string, path: string): string {
  return `${origin}\n${method}\n${path}`;
}

function isCollectorUrl(rawUrl: string, collectorUrl: URL): boolean {
  try {
    const url = new URL(rawUrl, typeof location === "undefined" ? undefined : location.href);
    return url.origin === collectorUrl.origin && url.pathname === collectorUrl.pathname;
  } catch {
    return false;
  }
}

function captureRequestBody(
  request: Request | RequestInit,
  headers: Headers,
  route: NormalizedRoute,
  maxBodyBytes: number,
  onDiscoveredSessionId?: (sessionId: string) => void,
): Promise<string | undefined> {
  if (!isJsonContentType(headers.get("content-type"))) return Promise.resolve(undefined);
  if (typeof Request !== "undefined" && request instanceof Request) {
    if (!request.body) return Promise.resolve(undefined);
    try {
      return readBoundedJsonStream(
        request.clone().body,
        headers.get("content-type"),
        route,
        maxBodyBytes,
        onDiscoveredSessionId,
      );
    } catch {
      return Promise.resolve(undefined);
    }
  }
  const body = request.body;
  if (typeof body === "string") {
    return Promise.resolve(sanitizedJsonBody(body, route, maxBodyBytes, onDiscoveredSessionId));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxBodyBytes) return Promise.resolve(undefined);
    return body
      .text()
      .then((text) => sanitizedJsonBody(text, route, maxBodyBytes, onDiscoveredSessionId))
      .catch(() => undefined);
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxBodyBytes) return Promise.resolve(undefined);
    return Promise.resolve(
      sanitizedJsonBody(new TextDecoder().decode(body), route, maxBodyBytes, onDiscoveredSessionId),
    );
  }
  if (ArrayBuffer.isView(body)) {
    if (body.byteLength > maxBodyBytes) return Promise.resolve(undefined);
    return Promise.resolve(sanitizedJsonBody(
      new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      route,
      maxBodyBytes,
      onDiscoveredSessionId,
    ));
  }
  return Promise.resolve(undefined);
}

function installFetchBodyObserver(
  fetchCalls: FetchCall[],
  capture: BodyCaptureConfig,
  allowedOrigins: Set<string>,
  collectorUrl: URL,
  onSessionId?: (sessionId: string) => void,
): () => void {
  const original = globalThis.fetch as typeof fetch & { __original?: typeof fetch };
  const underlying = original.__original ?? original;
  let active = true;
  const observer = function (this: typeof globalThis, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    let call: FetchCall | undefined;
    if (active) {
      try {
        const [resource, init] = args;
        const url = resource instanceof Request
          ? resource.url
          : resource instanceof URL
            ? resource.href
            : String(resource);
        const method = (init?.method ?? (resource instanceof Request ? resource.method : "GET")).toUpperCase();
        const route = isCollectorUrl(url, collectorUrl)
          ? undefined
          : findRoute(capture, allowedOrigins, url, method);
        if (route) {
          call = { url, method };
        }
      } catch {
        // Metadata observation cannot block the network request.
      }
    }
    if (!call) return Reflect.apply(original, this, args);
    fetchCalls.push(call);
    let response: ReturnType<typeof fetch>;
    try {
      response = Reflect.apply(original, this, args);
    } catch (error) {
      fetchCalls.pop();
      throw error;
    }
    fetchCalls.pop();
    if (!call.state) return response;
    const state = call.state;
    return response.then((value) => {
      if (!isResponse(value)) return value;
      state.responseStatus = value.status;
      try {
        state.responseBody = readBoundedJsonStream(
          value.clone().body,
          value.headers.get("content-type"),
          state.route,
          capture.maxBodyBytes,
          (discovered) => {
            if (!onSessionId) return;
            state.discoveredSessionId = discovered;
            onSessionId(discovered);
          },
        );
      } catch {
        state.responseBody = Promise.resolve(undefined);
      }
      return value;
    });
  };
  // The official OTLP browser exporter checks this hook to bypass its own
  // Fetch instrumentation. Keep that bypass intact through our metadata wrapper.
  Object.defineProperty(observer, "__original", { value: underlying });
  globalThis.fetch = observer as typeof fetch;
  return () => {
    active = false;
  };
}

function installXhrBodyObserver(
  states: WeakMap<XMLHttpRequest, XhrState>,
  capture: BodyCaptureConfig,
  allowedOrigins: Set<string>,
  collectorUrl: URL,
  onSessionId?: (sessionId: string) => void,
): () => void {
  if (typeof XMLHttpRequest === "undefined") return () => undefined;
  const prototype = XMLHttpRequest.prototype;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const originalSetRequestHeader = prototype.setRequestHeader;
  let active = true;

  prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    if (active) {
      states.delete(this);
      const normalizedMethod = method.toUpperCase();
      const rawUrl = url instanceof URL ? url.href : url;
      const route = isCollectorUrl(rawUrl, collectorUrl)
        ? undefined
        : findRoute(capture, allowedOrigins, rawUrl, normalizedMethod);
      if (route) {
        const discoveredSessionId = onSessionId ? extractSessionIdFromPath(route.path) : undefined;
        if (discoveredSessionId) {
          onSessionId?.(discoveredSessionId);
        }
        states.set(this, {
          route,
          requestUrl: `${route.origin}${route.path}`,
          requestMethod: normalizedMethod,
          contentType: "",
          maxBodyBytes: capture.maxBodyBytes,
          discoveredSessionId,
        });
      }
    }
    Reflect.apply(originalOpen, this, [method, url, async, username, password]);
  } as typeof prototype.open;

  prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
    Reflect.apply(originalSetRequestHeader, this, [name, value]);
    if (!active || name.toLowerCase() !== "content-type") return;
    const state = states.get(this);
    if (state) state.contentType = value;
  };

  prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const state = active ? states.get(this) : undefined;
    if (state && isJsonContentType(state.contentType) && typeof body === "string") {
      state.requestBody = sanitizedJsonBody(body, state.route, state.maxBodyBytes, (discovered) => {
        if (!onSessionId) return;
        state.discoveredSessionId = discovered;
        onSessionId(discovered);
      });
    }
    Reflect.apply(originalSend, this, [body]);
  };

  return () => {
    active = false;
  };
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && /^application\/(?:[a-z0-9._-]+\+)?json(?:\s*;|$)/i.test(contentType.trim());
}

function sanitizedJsonBody(
  text: string,
  route: NormalizedRoute,
  maxBodyBytes: number,
  onDiscoveredSessionId?: (sessionId: string) => void,
): string | undefined {
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (onDiscoveredSessionId) {
    const discovered = extractSessionIdFromJson(value, route.path);
    if (discovered) onDiscoveredSessionId(discovered);
  }
  redactBuiltinProperties(value);
  for (const path of route.redactionPaths) redactJsonPath(value, path);
  const sanitized = JSON.stringify(value);
  return new TextEncoder().encode(sanitized).byteLength <= maxBodyBytes ? sanitized : undefined;
}

async function readBoundedJsonStream(
  stream: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  route: NormalizedRoute,
  maxBodyBytes: number,
  onDiscoveredSessionId?: (sessionId: string) => void,
): Promise<string | undefined> {
  if (!stream || !isJsonContentType(contentType)) return undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(part.value);
    }
  } catch {
    return undefined;
  } finally {
    try { reader.releaseLock(); } catch { /* A canceled stream may retain its lock. */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return sanitizedJsonBody(
    new TextDecoder().decode(bytes),
    route,
    maxBodyBytes,
    onDiscoveredSessionId,
  );
}

function isValidSessionId(candidate: string): boolean {
  return /^[!-~]{1,128}$/.test(candidate);
}

function extractSessionIdFromPath(path: string): string | undefined {
  const match = path.match(/(?:^|\/)sessions\/([!-~]{1,128}?)(?:\/|$)/);
  const candidate = match?.[1];
  return candidate && isValidSessionId(candidate) ? candidate : undefined;
}

function extractSessionIdFromJson(value: unknown, routePath: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionId", "session_id"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && isValidSessionId(candidate.trim())) {
      return candidate.trim();
    }
  }
  if (/(?:^|\/)sessions?\/?$/i.test(routePath)) {
    const idCandidate = record.id;
    if (typeof idCandidate === "string" && isValidSessionId(idCandidate.trim())) {
      return idCandidate.trim();
    }
  }
  return undefined;
}

function applySessionIdToSpan(span: Span, sessionId: string): void {
  try {
    const candidate = span as unknown as {
      ended?: boolean;
      attributes?: Record<string, unknown>;
    };
    if (!candidate.ended) {
      span.setAttribute("session.id", sessionId);
      span.setAttribute("sp.session.id", sessionId);
    } else if (candidate.attributes && typeof candidate.attributes === "object") {
      candidate.attributes["session.id"] = sessionId;
      candidate.attributes["sp.session.id"] = sessionId;
    }
  } catch {}
}

function parseRedactionPath(path: string): string[] | null {
  if (typeof path !== "string" || !path.startsWith("$.")) return null;
  const parts = path.slice(2).split(".");
  if (parts.length === 0 || parts.some((part) =>
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) ||
    part === "__proto__" || part === "prototype" || part === "constructor"
  )) return null;
  return parts;
}

function redactBuiltinProperties(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) redactBuiltinProperties(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (BUILTIN_JSON_PROPERTY_REDACTIONS.includes(key)) {
      record[key] = REDACTED_VALUE;
      continue;
    }
    redactBuiltinProperties(record[key]);
  }
}

function redactJsonPath(value: unknown, path: string[], index = 0): void {
  if (value === null || typeof value !== "object") return;
  const key = path[index]!;
  if (!Object.hasOwn(value, key)) return;
  if (index === path.length - 1) {
    (value as Record<string, unknown>)[key] = REDACTED_VALUE;
    return;
  }
  redactJsonPath((value as Record<string, unknown>)[key], path, index + 1);
}

function isResponse(value: Response | { message: string }): value is Response {
  return typeof Response !== "undefined" && value instanceof Response;
}
