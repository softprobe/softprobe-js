import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionIdHeaderName,
  initializeHttpInterceptor,
  isSameOriginRequest,
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

  it("injects x-sp-session-id on same-origin fetch", async () => {
    let seen: HeadersInit | undefined;
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async (_url, init) => {
        seen = init?.headers;
        return new Response("ok");
      }) as typeof fetch,
    );

    let sessionId = "ses_1";
    initializeHttpInterceptor(() => sessionId);

    await fetch("/api/x", { headers: { Accept: "application/json" } });
    expect(seen).toMatchObject({
      Accept: "application/json",
      [getSessionIdHeaderName()]: "ses_1",
    });

    sessionId = "ses_2";
    await fetch("/api/y");
    expect(seen).toMatchObject({ [getSessionIdHeaderName()]: "ses_2" });

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

    initializeHttpInterceptor(() => "ses_cdn");
    await fetch("https://cdn.example.net/lib.js", {
      headers: { Accept: "*/*" },
    });
    expect(seen).toEqual({ Accept: "*/*" });
    expect(
      JSON.stringify(seen ?? {}).includes(getSessionIdHeaderName()),
    ).toBe(false);

    globalThis.fetch = original;
  });

  it("injects when absolute URL matches location.origin", async () => {
    let seen: HeadersInit | undefined;
    const original = globalThis.fetch;
    resetFetchPatch(
      vi.fn(async (_url, init) => {
        seen = init?.headers;
        return new Response("ok");
      }) as typeof fetch,
    );

    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    initializeHttpInterceptor(() => "ses_same");
    await fetch("https://app.example.com/api/replay");
    expect(seen).toMatchObject({
      [getSessionIdHeaderName()]: "ses_same",
    });

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

    initializeHttpInterceptor(() => "ses_req");
    // jsdom Request requires an absolute URL.
    const request = new Request("https://app.example.com/api/agent", {
      headers: { Authorization: "Bearer abc", "X-Custom": "1" },
    });
    await fetch(request);

    expect(seen?.get("Authorization")).toBe("Bearer abc");
    expect(seen?.get("X-Custom")).toBe("1");
    expect(seen?.get(getSessionIdHeaderName())).toBe("ses_req");

    globalThis.fetch = original;
  });

  it("isSameOriginRequest treats relative paths as same-origin", () => {
    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });
    expect(isSameOriginRequest("/api/x")).toBe(true);
    expect(isSameOriginRequest("https://cdn.other.com/x")).toBe(false);
    expect(isSameOriginRequest("https://app.example.com/y")).toBe(true);
  });
});
