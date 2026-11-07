import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeHttpInterceptor,
} from "../src/http-interceptor.js";

function resetFetchPatch(mockFetch: typeof fetch): void {
  globalThis.fetch = mockFetch;
  delete (globalThis.fetch as { __sp_sdk_patched_fetch?: boolean })
    .__sp_sdk_patched_fetch;
  delete (XMLHttpRequest as unknown as { __sp_sdk_patched_xhr?: boolean })
    .__sp_sdk_patched_xhr;
}

describe("http interceptor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not inject a session ID into same-origin fetches", async () => {
    let seen: Headers | undefined;
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async (_url, init) => {
        seen = new Headers(init?.headers);
        return new Response("ok");
      }) as typeof fetch,
    );

    initializeHttpInterceptor();

    await fetch("/api/x", { headers: { Accept: "application/json" } });
    expect(seen?.get("Accept")).toBe("application/json");
    expect(seen?.has("x-sp-session-id")).toBe(false);

    globalThis.fetch = original;
  });

  it("skips third-party / CDN fetch URLs", async () => {
    let seen: HeadersInit | undefined;
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async (_url, init) => {
        seen = init?.headers;
        return new Response("ok");
      }) as typeof fetch,
    );

    // jsdom provides location; stub origin for a known page.
    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    initializeHttpInterceptor({
      apiOrigins: ["https://app.example.com"],
      createRequestSpan: () => ({
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        finish: () => undefined,
      }),
    });
    await fetch("https://cdn.example.net/lib.js", {
      headers: { Accept: "*/*" },
    });
    expect(seen).toEqual({ Accept: "*/*" });
    expect(JSON.stringify(seen ?? {}).includes("x-sp-session-id")).toBe(false);

    globalThis.fetch = original;
  });

  it("does not inject session IDs into absolute same-origin URLs", async () => {
    let seen: Headers | undefined;
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async (_url, init) => {
        seen = new Headers(init?.headers);
        return new Response("ok");
      }) as typeof fetch,
    );

    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    initializeHttpInterceptor();
    await fetch("https://app.example.com/api/replay");
    expect(seen?.has("x-sp-session-id")).toBe(false);

    globalThis.fetch = original;
  });

  it("injects trace context only for exactly selected API origins", async () => {
    const seen = new Map<string, Headers>();
    const finished: Array<{ status: number; error?: unknown }> = [];
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.set(url, new Headers(init?.headers));
        return new Response("ok", { status: 201 });
      }) as typeof fetch,
    );
    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    initializeHttpInterceptor({
      apiOrigins: ["https://api.example.net"],
      createRequestSpan: () => ({
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        finish: (status, error) => finished.push({ status, error }),
      }),
    });

    await fetch("https://api.example.net/v1/orders");
    await fetch("https://sub.api.example.net/v1/orders");
    await fetch("https://cdn.example.net/v1/script.js");

    expect(seen.get("https://api.example.net/v1/orders")?.get("traceparent"))
      .toBe("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    expect(seen.get("https://sub.api.example.net/v1/orders")?.has("traceparent"))
      .toBe(false);
    expect(seen.get("https://cdn.example.net/v1/script.js")?.has("traceparent"))
      .toBe(false);
    expect(seen.get("https://api.example.net/v1/orders")?.has("x-sp-session-id"))
      .toBe(false);
    expect(finished).toEqual([{ status: 201, error: undefined }]);

    globalThis.fetch = original;
  });

  it("merges headers from a Request resource instead of dropping them", async () => {
    let seen: Headers | undefined;
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async (_resource, init) => {
        seen = new Headers(init?.headers);
        return new Response("ok");
      }) as typeof fetch,
    );

    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    initializeHttpInterceptor({
      apiOrigins: ["https://app.example.com"],
      createRequestSpan: () => ({
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        finish: () => undefined,
      }),
    });
    // jsdom Request requires an absolute URL.
    const request = new Request("https://app.example.com/api/agent", {
      headers: { Authorization: "Bearer abc", "X-Custom": "1" },
    });
    await fetch(request);

    expect(seen?.get("Authorization")).toBe("Bearer abc");
    expect(seen?.get("X-Custom")).toBe("1");
    expect(seen?.get("traceparent")).toBe(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    expect(seen?.has("x-sp-session-id")).toBe(false);

    globalThis.fetch = original;
  });

  it("captures and redacts JSON bodies only for an exact configured route", async () => {
    let resolveCapture!: (value: {
      status: number;
      error?: unknown;
      bodies?: { requestBody?: string; responseBody?: string };
    }) => void;
    const captured = new Promise<{
      status: number;
      error?: unknown;
      bodies?: { requestBody?: string; responseBody?: string };
    }>((resolve) => { resolveCapture = resolve; });
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    );
    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    initializeHttpInterceptor({
      apiOrigins: ["https://api.example.net"],
      httpBodyCapture: {
        maxBodyBytes: 1024,
        routes: [{
          origin: "https://api.example.net",
          method: "POST",
          path: "/api/pay",
          redactJsonPaths: ["$.paymentDetails.cardNumber", "$.paymentDetails.cvv"],
        }],
      },
      createRequestSpan: () => ({
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        finish: (status, error, bodies) => resolveCapture({ status, error, bodies }),
      }),
    });

    const response = await fetch("https://api.example.net/api/pay?token=private", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentDetails: { cardNumber: "4111111111111111", cvv: "314" },
        amount: "42.00",
      }),
    });
    expect(await response.json()).toEqual({ status: "ok" });
    const result = await captured;

    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.bodies?.requestBody ?? "{}")).toEqual({
      paymentDetails: { cardNumber: "[REDACTED]", cvv: "[REDACTED]" },
      amount: "42.00",
    });
    expect(result.bodies?.responseBody).toBe('{"status":"ok"}');
    expect(JSON.stringify(result.bodies)).not.toContain("4111111111111111");
    expect(JSON.stringify(result.bodies)).not.toContain('"314"');

    globalThis.fetch = original;
  });

  it("omits nonmatching and oversized JSON bodies", async () => {
    const captures: Array<{ requestBody?: string; responseBody?: string }> = [];
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async () => new Response(JSON.stringify({ result: "too-large" }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    );
    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    initializeHttpInterceptor({
      apiOrigins: ["https://api.example.net"],
      httpBodyCapture: {
        maxBodyBytes: 8,
        routes: [{
          origin: "https://api.example.net",
          method: "POST",
          path: "/api/capture",
        }],
      },
      createRequestSpan: () => ({
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        finish: (_status, _error, bodies) => captures.push(bodies ?? {}),
      }),
    });

    await fetch("https://api.example.net/api/other", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"x":1}',
    });
    await fetch("https://api.example.net/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"too":"large"}',
    });
    await vi.waitFor(() => expect(captures).toHaveLength(2));

    expect(captures).toEqual([{}, {}]);
    globalThis.fetch = original;
  });

  it("captures JSON bodies from XHR without changing its response", async () => {
    let resolveCapture!: (bodies: { requestBody?: string; responseBody?: string } | undefined) => void;
    const captured = new Promise<{ requestBody?: string; responseBody?: string } | undefined>(
      (resolve) => { resolveCapture = resolve; },
    );
    class MockXHR extends EventTarget {
      status = 200;
      responseType: XMLHttpRequestResponseType = "";
      responseText = '{"ok":true}';
      sentBody?: Document | XMLHttpRequestBodyInit | null;
      private readonly headers = new Headers();

      open(): void {}

      setRequestHeader(name: string, value: string): void {
        this.headers.set(name, value);
      }

      getResponseHeader(name: string): string | null {
        return name.toLowerCase() === "content-type" ? "application/json" : null;
      }

      send(body?: Document | XMLHttpRequestBodyInit | null): void {
        this.sentBody = body;
        this.dispatchEvent(new Event("loadend"));
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXHR);
    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });
    initializeHttpInterceptor({
      apiOrigins: ["https://api.example.net"],
      httpBodyCapture: {
        maxBodyBytes: 1024,
        routes: [{ origin: "https://api.example.net", method: "POST", path: "/api/orders" }],
      },
      createRequestSpan: () => ({
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        finish: (_status, _error, bodies) => resolveCapture(bodies),
      }),
    });

    const xhr = new XMLHttpRequest() as unknown as MockXHR;
    xhr.open("POST", "https://api.example.net/api/orders");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send('{"orderId":"ord-1"}');

    expect(xhr.sentBody).toBe('{"orderId":"ord-1"}');
    expect(xhr.responseText).toBe('{"ok":true}');
    await expect(captured).resolves.toEqual({
      requestBody: '{"orderId":"ord-1"}',
      responseBody: '{"ok":true}',
    });
  });
});
