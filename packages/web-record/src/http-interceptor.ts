const HEADER_X_SP_SESSION_ID = "x-sp-session-id";

type SessionIdProvider = () => string;

let sessionIdProvider: SessionIdProvider | null = null;

export function getSessionIdHeaderName(): string {
  return HEADER_X_SP_SESSION_ID;
}

/**
 * Patches XHR + fetch to inject `x-sp-session-id` on same-origin requests only.
 * Provider is consulted on each request so session switches take effect.
 */
export function initializeHttpInterceptor(getSessionId: SessionIdProvider): void {
  sessionIdProvider = getSessionId;
  patchXMLHttpRequest();
  patchFetchAPI();
}

export function updateHttpInterceptorSessionId(getSessionId: SessionIdProvider): void {
  sessionIdProvider = getSessionId;
}

function currentSessionId(): string {
  return sessionIdProvider?.() ?? "";
}

/** Relative URLs and same `location.origin` only — skip third-party/CDN. */
export function isSameOriginRequest(resource: RequestInfo | URL): boolean {
  try {
    let href: string;
    if (typeof Request !== "undefined" && resource instanceof Request) {
      href = resource.url;
    } else if (resource instanceof URL) {
      href = resource.href;
    } else {
      href = String(resource);
    }

    // Scheme-relative or absolute with a scheme → compare origins.
    // Bare paths (`/api`, `./x`) resolve against location and are same-origin.
    if (typeof location === "undefined") {
      // No browsing context (e.g. unit tests without jsdom location): treat
      // relative paths as same-origin; absolute http(s) as cross-origin.
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !href.startsWith("//")) {
        return true;
      }
      return false;
    }

    const resolved = new URL(href, location.href);
    return resolved.origin === location.origin;
  } catch {
    return false;
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
    (this as XMLHttpRequest & { __sp_request_url?: string | URL }).__sp_request_url =
      url;
    return originalOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const sid = currentSessionId();
    const url = (this as XMLHttpRequest & { __sp_request_url?: string | URL })
      .__sp_request_url;
    if (sid && url !== undefined && isSameOriginRequest(url)) {
      try {
        this.setRequestHeader(HEADER_X_SP_SESSION_ID, sid);
      } catch {
        // Headers may already be sent; never block the request.
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
    const sid = currentSessionId();
    if (!sid || !isSameOriginRequest(resource)) {
      return originalFetch(resource, options);
    }

    try {
      if (typeof Request !== "undefined" && resource instanceof Request) {
        const headers = new Headers(resource.headers);
        if (options?.headers) {
          new Headers(options.headers).forEach((value, key) => {
            headers.set(key, value);
          });
        }
        headers.set(HEADER_X_SP_SESSION_ID, sid);
        return originalFetch(resource, { ...options, headers });
      }

      const next: RequestInit = { ...(options ?? {}) };
      const headers = next.headers ?? {};
      if (headers instanceof Headers) {
        headers.set(HEADER_X_SP_SESSION_ID, sid);
        next.headers = headers;
      } else if (Array.isArray(headers)) {
        next.headers = [...headers, [HEADER_X_SP_SESSION_ID, sid]];
      } else {
        next.headers = {
          ...(headers as Record<string, string>),
          [HEADER_X_SP_SESSION_ID]: sid,
        };
      }
      return originalFetch(resource, next);
    } catch {
      return originalFetch(resource, options);
    }
  }) as typeof fetch;

  g.fetch.__sp_sdk_patched_fetch = true;
}
