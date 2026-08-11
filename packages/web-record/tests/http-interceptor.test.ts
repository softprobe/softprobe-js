import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionIdHeaderName,
  initializeHttpInterceptor,
} from "../src/http-interceptor.js";

describe("http interceptor", () => {
  afterEach(() => {
    // jsdom reuses globalThis; leave patched but provider can change.
  });

  it("injects x-sp-session-id on fetch", async () => {
    let seen: HeadersInit | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      seen = init?.headers;
      return new Response("ok");
    }) as typeof fetch;
    // Reset patch flag so we can re-patch against the mock.
    delete (globalThis.fetch as { __sp_sdk_patched_fetch?: boolean })
      .__sp_sdk_patched_fetch;
    // Also clear any prior patch marker on XMLHttpRequest.
    delete (XMLHttpRequest as unknown as { __sp_sdk_patched_xhr?: boolean })
      .__sp_sdk_patched_xhr;

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
});
