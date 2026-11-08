import {
  compileHttpCapture,
  httpCaptureRouteKey,
  parseExactHttpOrigin,
  redactParsedJson,
  type HttpCapturePlan,
  type HttpCaptureRoute,
} from "./record-init.js";
import type { HttpBodyCaptureOptions } from "./types.js";

export type CapturedHttpBodies = {
  requestBody?: string;
  responseBody?: string;
};

export type RequestTraceHandle = {
  traceparent: string;
  tracestate?: string;
  finish: (status: number, error?: unknown, bodies?: CapturedHttpBodies) => void;
};

export type RequestSpanFactory = (
  method: string,
  url: string,
) => RequestTraceHandle | null;

export type HttpInterceptorOptions = {
  /** Exact HTTP(S) origins allowed to receive W3C trace context. */
  apiOrigins?: string[];
  httpBodyCapture?: HttpBodyCaptureOptions;
  createRequestSpan?: RequestSpanFactory;
};

let selectedApiOrigins = new Set<string>();
let requestSpanFactory: RequestSpanFactory | null = null;
let bodyCapture: HttpCapturePlan | null = null;

/**
 * Patches XHR + fetch to inject W3C trace context only on explicitly selected
 * API origins. Session correlation is carried by exported spans, not request
 * headers.
 */
export function initializeHttpInterceptor(
  options: HttpInterceptorOptions = {},
): void {
  selectedApiOrigins = normalizeApiOrigins(options.apiOrigins ?? []);
  requestSpanFactory = options.createRequestSpan ?? null;
  bodyCapture = compileHttpCapture(options.httpBodyCapture, selectedApiOrigins);
  patchXMLHttpRequest();
  patchFetchAPI();
}

function normalizeApiOrigins(origins: string[]): Set<string> {
  const result = new Set<string>();
  for (const candidate of origins) {
    // Invalid entries never widen trace-context injection.
    const origin = parseExactHttpOrigin(candidate);
    if (origin) result.add(origin);
  }
  return result;
}

function resourceUrl(resource: RequestInfo | URL): string {
  if (typeof Request !== "undefined" && resource instanceof Request) {
    return resource.url;
  }
  return resource instanceof URL ? resource.href : String(resource);
}

function selectedOriginFor(resource: RequestInfo | URL): string | null {
  try {
    const href = resourceUrl(resource);
    const base = typeof location !== "undefined" ? location.href : undefined;
    const parsed = base ? new URL(href, base) : new URL(href);
    return selectedApiOrigins.has(parsed.origin) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function createRequestTrace(
  resource: RequestInfo | URL,
  method: string,
): RequestTraceHandle | null {
  if (!requestSpanFactory || !selectedOriginFor(resource)) return null;
  try {
    return requestSpanFactory(method.toUpperCase(), resourceUrl(resource));
  } catch {
    return null;
  }
}

function bodyCaptureRouteFor(
  resource: RequestInfo | URL | string,
  method: string,
): HttpCaptureRoute | null {
  if (!bodyCapture || !selectedOriginFor(resource)) return null;
  try {
    const base = typeof location !== "undefined" ? location.href : undefined;
    const parsed = new URL(typeof resource === "string" ? resource : resourceUrl(resource), base);
    return bodyCapture.routes.get(httpCaptureRouteKey(parsed.origin, method.toUpperCase(), parsed.pathname)) ?? null;
  } catch {
    return null;
  }
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && /^application\/(?:[a-z0-9._-]+\+)?json(?:\s*;|$)/i.test(contentType.trim());
}

function sanitizedJsonBody(
  text: string,
  route: HttpCaptureRoute,
  plan: HttpCapturePlan,
): string | undefined {
  if (new TextEncoder().encode(text).byteLength > plan.maxBodyBytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  redactParsedJson(value, plan.builtinPropertyRedactions, route.extraRedactionPaths);
  const sanitized = JSON.stringify(value);
  return new TextEncoder().encode(sanitized).byteLength <= plan.maxBodyBytes ? sanitized : undefined;
}

async function readBoundedJsonStream(
  stream: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  route: HttpCaptureRoute,
  plan: HttpCapturePlan,
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
      if (size > plan.maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(part.value);
    }
  } catch {
    return undefined;
  } finally {
    try { reader.releaseLock(); } catch { /* a canceled stream may still hold its lock */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return sanitizedJsonBody(new TextDecoder().decode(bytes), route, plan);
}

function captureFetchRequestBody(
  resource: RequestInfo | URL,
  options: RequestInit | undefined,
  headers: Headers,
  route: HttpCaptureRoute,
  plan: HttpCapturePlan,
): Promise<string | undefined> {
  if (!isJsonContentType(headers.get("content-type"))) return Promise.resolve(undefined);
  if (options && Object.hasOwn(options, "body")) {
    return Promise.resolve(typeof options.body === "string"
      ? sanitizedJsonBody(options.body, route, plan)
      : undefined);
  }
  if (typeof Request === "undefined" || !(resource instanceof Request) || !resource.body) {
    return Promise.resolve(undefined);
  }
  try {
    const clone = resource.clone();
    return readBoundedJsonStream(clone.body, headers.get("content-type"), route, plan);
  } catch {
    return Promise.resolve(undefined);
  }
}

function finishRequestTrace(
  span: RequestTraceHandle | null,
  status: number,
  error?: unknown,
  bodies?: CapturedHttpBodies,
): void {
  try {
    span?.finish(status, error, bodies);
  } catch {
    // Tracing must never change application request behavior.
  }
}

function patchXMLHttpRequest(): void {
  if (typeof XMLHttpRequest === "undefined") return;
  if ((XMLHttpRequest as unknown as { __sp_sdk_patched_xhr?: boolean }).__sp_sdk_patched_xhr) {
    return;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.setRequestHeader = function (
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    const result = originalSetRequestHeader.call(this, name, value);
    const traced = this as XMLHttpRequest & { __sp_request_headers?: Headers };
    try {
      traced.__sp_request_headers ??= new Headers();
      traced.__sp_request_headers.append(name, value);
    } catch {
      // Header observation must not change the application request.
    }
    return result;
  };

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const traced = this as XMLHttpRequest & {
      __sp_request_url?: string | URL;
      __sp_request_method?: string;
      __sp_request_headers?: Headers;
    };
    traced.__sp_request_url = url;
    traced.__sp_request_method = method;
    traced.__sp_request_headers = new Headers();
    return originalOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const traced = this as XMLHttpRequest & {
      __sp_request_url?: string | URL;
      __sp_request_method?: string;
      __sp_request_headers?: Headers;
    };
    const url = traced.__sp_request_url;
    const method = traced.__sp_request_method ?? "GET";
    const span = url === undefined
      ? null
      : createRequestTrace(url, method);
    const route = url === undefined ? null : bodyCaptureRouteFor(url, method);
    const requestBody = route && bodyCapture
      && isJsonContentType(traced.__sp_request_headers?.get("content-type") ?? null)
      && typeof body === "string"
      ? sanitizedJsonBody(body, route, bodyCapture)
      : undefined;
    if (span) {
      try {
        this.setRequestHeader("traceparent", span.traceparent);
        if (span.tracestate) this.setRequestHeader("tracestate", span.tracestate);
      } catch {
        // A failed propagation header must not block the application request.
      }
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        const status = this.status;
        let responseBody: string | undefined;
        let responseContentType: string | null = null;
        try { responseContentType = this.getResponseHeader("content-type"); } catch { /* Failed requests may have no response headers. */ }
        if (route && bodyCapture && isJsonContentType(responseContentType)) {
          try {
            const raw = this.responseType === "json"
              ? JSON.stringify(this.response)
              : this.responseType === "" || this.responseType === "text"
              ? this.responseText
              : undefined;
            if (typeof raw === "string") {
              responseBody = sanitizedJsonBody(raw, route, bodyCapture);
            }
          } catch {
            responseBody = undefined;
          }
        }
        finishRequestTrace(
          span,
          status,
          status === 0 ? new Error("XHR request did not receive a response") : undefined,
          route ? { requestBody, responseBody } : undefined,
        );
      };
      this.addEventListener("loadend", finish, { once: true });
      try {
        return originalSend.call(this, body);
      } catch (error) {
        finishRequestTrace(span, 0, error, route ? { requestBody } : undefined);
        throw error;
      }
    }
    return originalSend.call(this, body);
  };

  (XMLHttpRequest as unknown as { __sp_sdk_patched_xhr?: boolean }).__sp_sdk_patched_xhr = true;
}

function patchFetchAPI(): void {
  if (typeof globalThis.fetch === "undefined") return;
  const g = globalThis as typeof globalThis & {
    fetch: typeof fetch & { __sp_sdk_patched_fetch?: boolean };
  };
  if (g.fetch.__sp_sdk_patched_fetch) return;

  const originalFetch = g.fetch.bind(globalThis);

  g.fetch = (async function patchedFetch(
    resource: RequestInfo | URL,
    options?: RequestInit,
  ): Promise<Response> {
    const method = options?.method ??
      (typeof Request !== "undefined" && resource instanceof Request
        ? resource.method
        : "GET");
    const span = createRequestTrace(resource, method);
    if (!span) return originalFetch(resource, options);
    const route = bodyCaptureRouteFor(resource, method);

    let requestOptions = options;
    let headers: Headers;
    try {
      headers = new Headers(
        typeof Request !== "undefined" && resource instanceof Request
          ? resource.headers
          : options?.headers,
      );
      if (typeof Request !== "undefined" && resource instanceof Request && options?.headers) {
        new Headers(options.headers).forEach((value, key) => headers.set(key, value));
      }
      if (span) {
        headers.set("traceparent", span.traceparent);
        if (span.tracestate) headers.set("tracestate", span.tracestate);
      }
      requestOptions = { ...(options ?? {}), headers };
    } catch {
      // Invalid or unsupported header input should not block the application request.
      finishRequestTrace(span, 0, new Error("Unable to inject request headers"));
      return originalFetch(resource, options);
    }

    const requestCapture = route && bodyCapture
      ? captureFetchRequestBody(resource, requestOptions, headers, route, bodyCapture)
      : Promise.resolve(undefined);

    try {
      const response = await originalFetch(resource, requestOptions);
      if (route && bodyCapture) {
        const responseCapture = readBoundedJsonStream(
          response.clone().body,
          response.headers.get("content-type"),
          route,
          bodyCapture,
        );
        void Promise.all([requestCapture, responseCapture]).then(([requestBody, responseBody]) => {
          finishRequestTrace(span, response.status, undefined, { requestBody, responseBody });
        }, (error) => {
          finishRequestTrace(span, response.status, error);
        });
      } else {
        finishRequestTrace(span, response.status);
      }
      return response;
    } catch (error) {
      if (route && bodyCapture) {
        void requestCapture.then((requestBody) => finishRequestTrace(
          span,
          0,
          error,
          { requestBody },
        ), () => finishRequestTrace(span, 0, error));
      } else {
        finishRequestTrace(span, 0, error);
      }
      throw error;
    }
  }) as typeof fetch;

  g.fetch.__sp_sdk_patched_fetch = true;
}
