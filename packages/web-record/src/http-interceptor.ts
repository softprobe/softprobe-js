export type RequestTraceHandle = {
  traceparent: string;
  tracestate?: string;
  finish: (status: number, error?: unknown) => void;
};

export type RequestSpanFactory = (
  method: string,
  url: string,
) => RequestTraceHandle | null;

export type HttpInterceptorOptions = {
  /** Exact HTTP(S) origins allowed to receive W3C trace context. */
  apiOrigins?: string[];
  createRequestSpan?: RequestSpanFactory;
};

let selectedApiOrigins = new Set<string>();
let requestSpanFactory: RequestSpanFactory | null = null;

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
  patchXMLHttpRequest();
  patchFetchAPI();
}

function normalizeApiOrigins(origins: string[]): Set<string> {
  const result = new Set<string>();
  for (const candidate of origins) {
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !parsed.username &&
        !parsed.password &&
        parsed.pathname === "/" &&
        !parsed.search &&
        !parsed.hash
      ) {
        result.add(parsed.origin);
      }
    } catch {
      // Invalid entries never widen trace-context injection.
    }
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

function finishRequestTrace(
  span: RequestTraceHandle | null,
  status: number,
  error?: unknown,
): void {
  try {
    span?.finish(status, error);
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
    };
    traced.__sp_request_url = url;
    traced.__sp_request_method = method;
    return originalOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const traced = this as XMLHttpRequest & {
      __sp_request_url?: string | URL;
      __sp_request_method?: string;
    };
    const url = traced.__sp_request_url;
    const span = url === undefined
      ? null
      : createRequestTrace(url, traced.__sp_request_method ?? "GET");
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
        finishRequestTrace(
          span,
          status,
          status === 0 ? new Error("XHR request did not receive a response") : undefined,
        );
      };
      this.addEventListener("loadend", finish, { once: true });
      try {
        return originalSend.call(this, body);
      } catch (error) {
        finishRequestTrace(span, 0, error);
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

    let requestOptions = options;
    try {
      const headers = new Headers(
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

    try {
      const response = await originalFetch(resource, requestOptions);
      finishRequestTrace(span, response.status);
      return response;
    } catch (error) {
      finishRequestTrace(span, 0, error);
      throw error;
    }
  }) as typeof fetch;

  g.fetch.__sp_sdk_patched_fetch = true;
}
