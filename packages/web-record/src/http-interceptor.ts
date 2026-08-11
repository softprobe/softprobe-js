const HEADER_X_SP_SESSION_ID = "x-sp-session-id";

type SessionIdProvider = () => string;

let sessionIdProvider: SessionIdProvider | null = null;

export function getSessionIdHeaderName(): string {
  return HEADER_X_SP_SESSION_ID;
}

/**
 * Patches XHR + fetch to inject `x-sp-session-id`.
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
    return originalOpen.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const sid = currentSessionId();
    if (sid) {
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
    if (!sid) return originalFetch(resource, options);

    const next: RequestInit = { ...(options ?? {}) };
    const headers = next.headers ?? {};
    try {
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
    } catch {
      // Continue without the header.
    }
    return originalFetch(resource, next);
  }) as typeof fetch;

  g.fetch.__sp_sdk_patched_fetch = true;
}
