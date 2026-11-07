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
});
