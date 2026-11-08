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
  routes: Map<string, NormalizedRoute>;
};

type BodyState = {
  route: NormalizedRoute;
  requestUrl: string;
  requestMethod: string;
  requestBody: Promise<string | undefined>;
  responseBody: Promise<string | undefined>;
  responseStatus?: number;
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
  apiOrigins: string[];
  httpBodyCapture?: HttpBodyCaptureOptions;
  collectorUrl: string;
  getTracer: () => Tracer;
}): HttpBodyCaptureHooks {
  const allowedOrigins = normalizeOrigins(options.apiOrigins);
  const capture = normalizeCaptureOptions(options.httpBodyCapture, allowedOrigins);
  const collectorUrl = new URL(options.collectorUrl);
  const fetchStates = new WeakMap<Span, BodyState>();
  const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();
  const fetchCalls: FetchCall[] = [];
  let disposeFetchObserver = (): void => undefined;
  let fetchObserverInstalled = false;
  const disposeXhrObserver = capture
    ? installXhrBodyObserver(xhrStates, capture, allowedOrigins, collectorUrl)
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
    const state: BodyState = {
      route,
      requestUrl: `${route.origin}${route.path}`,
      requestMethod: call.method,
      requestBody: captureRequestBody(request, headers, route, capture.maxBodyBytes),
      responseBody: Promise.resolve(undefined),
    };
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
    );
  };

  const applyXhrCustomAttributes = (span: Span, xhr: XMLHttpRequest): void => {
    const state = xhrStates.get(xhr);
    if (!state || !capture) return;
    xhrStates.delete(xhr);
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
        : sanitizedJsonBody(responseText, state.route, capture.maxBodyBytes),
    );
    void finishBodySpan(
      span,
      state,
      Promise.resolve(state.requestBody),
      responseBody,
      xhr.status || undefined,
      options.getTracer,
    );
  };

  return {
    fetch: {
      requestHook,
      applyCustomAttributesOnSpan,
      installObserver: () => {
        if (fetchObserverInstalled || !capture || typeof globalThis.fetch !== "function") return;
        fetchObserverInstalled = true;
        disposeFetchObserver = installFetchBodyObserver(fetchCalls, capture, allowedOrigins, collectorUrl);
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
  options: HttpBodyCaptureOptions | undefined,
  allowedOrigins: Set<string>,
): BodyCaptureConfig | null {
  if (!options || !Array.isArray(options.routes)) return null;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > MAX_BODY_BYTES) {
    return null;
  }

  const routes = new Map<string, NormalizedRoute>();
  for (const candidate of options.routes as HttpBodyCaptureRoute[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const method = typeof candidate.method === "string" ? candidate.method.trim().toUpperCase() : "";
    const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
    if (!/^[A-Z]+$/.test(method) || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
      continue;
    }

    let origin: string;
    try {
      const parsed = new URL(candidate.origin);
      if (
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        continue;
      }
      origin = parsed.origin;
    } catch {
      continue;
    }
    if (!allowedOrigins.has(origin)) continue;

    const redactionPaths = candidate.redactJsonPaths ?? [];
    if (!Array.isArray(redactionPaths)) continue;
    const parsedPaths = redactionPaths.map(parseRedactionPath);
    if (parsedPaths.some((parts) => parts === null)) continue;
    routes.set(routeKey(origin, method, path), {
      origin,
      method,
      path,
      redactionPaths: parsedPaths as string[][],
    });
  }

  return routes.size ? { maxBodyBytes, routes } : null;
}

function normalizeOrigins(origins: string[]): Set<string> {
  const result = new Set<string>();
  for (const candidate of origins) {
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
        result.add(url.origin);
      }
    } catch {
      // Invalid origins do not grant body capture.
    }
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
    return capture.routes.get(routeKey(url.origin, method.toUpperCase(), url.pathname));
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
): Promise<string | undefined> {
  if (!isJsonContentType(headers.get("content-type"))) return Promise.resolve(undefined);
  if (typeof Request !== "undefined" && request instanceof Request) {
    if (!request.body) return Promise.resolve(undefined);
    try {
      return readBoundedJsonStream(request.clone().body, headers.get("content-type"), route, maxBodyBytes);
    } catch {
      return Promise.resolve(undefined);
    }
  }
  const body = request.body;
  if (typeof body === "string") {
    return Promise.resolve(sanitizedJsonBody(body, route, maxBodyBytes));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxBodyBytes) return Promise.resolve(undefined);
    return body.text().then((text) => sanitizedJsonBody(text, route, maxBodyBytes)).catch(() => undefined);
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxBodyBytes) return Promise.resolve(undefined);
    return Promise.resolve(sanitizedJsonBody(new TextDecoder().decode(body), route, maxBodyBytes));
  }
  if (ArrayBuffer.isView(body)) {
    if (body.byteLength > maxBodyBytes) return Promise.resolve(undefined);
    return Promise.resolve(sanitizedJsonBody(
      new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      route,
      maxBodyBytes,
    ));
  }
  return Promise.resolve(undefined);
}

function installFetchBodyObserver(
  fetchCalls: FetchCall[],
  capture: BodyCaptureConfig,
  allowedOrigins: Set<string>,
  collectorUrl: URL,
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
        states.set(this, {
          route,
          requestUrl: `${route.origin}${route.path}`,
          requestMethod: normalizedMethod,
          contentType: "",
          maxBodyBytes: capture.maxBodyBytes,
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
      state.requestBody = sanitizedJsonBody(body, state.route, state.maxBodyBytes);
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
): string | undefined {
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const path of route.redactionPaths) redactJsonPath(value, path);
  const sanitized = JSON.stringify(value);
  return new TextEncoder().encode(sanitized).byteLength <= maxBodyBytes ? sanitized : undefined;
}

async function readBoundedJsonStream(
  stream: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  route: NormalizedRoute,
  maxBodyBytes: number,
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
  return sanitizedJsonBody(new TextDecoder().decode(bytes), route, maxBodyBytes);
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
