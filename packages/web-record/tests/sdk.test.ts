import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("rrweb", () => ({
  pack: (data: unknown) => JSON.stringify(data),
  record: () => () => {},
}));

import { EVENT_NAME, EVENTS_ATTR, SPAN_NAME } from "../src/otlp.js";
import { RecordSdk } from "../src/sdk.js";

describe("RecordSdk.init", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("soft-disables when credentials are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sdk = RecordSdk.init({ softDisable: true } as never);
    expect(sdk.enabled).toBe(false);
    expect(sdk.record()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("throws when softDisable is false and credentials missing", () => {
    expect(() =>
      RecordSdk.init({ softDisable: false } as never),
    ).toThrow(/publicKey and baseUrl/);
  });

  it("honors explicit sessionId and setSessionId", () => {
    const sdk = RecordSdk.init({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      sessionId: "ses_open",
      manual: true,
    });
    expect(sdk.enabled).toBe(true);
    expect(sdk.sessionId).toBe("ses_open");
    sdk.setSessionId("ses_next");
    expect(sdk.sessionId).toBe("ses_next");
  });

  it("flushes OTLP envelope and clears buffer on success", async () => {
    const posts: Array<{ url: string; headers: HeadersInit; body: string }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        posts.push({
          url: String(url),
          headers: init?.headers as HeadersInit,
          body: String(init?.body ?? ""),
        });
        return new Response("{}", { status: 200 });
      }),
    );

    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      sessionId: "ses_flush",
      manual: true,
      serviceName: "test-web",
    }) as InstanceType<typeof RecordSdk>;

    // Inject buffered events without starting rrweb.
    (sdk as unknown as { events: unknown[] }).events = [
      { type: 4, timestamp: 1000, data: { href: "http://x" }, eventIndex: 1 },
      {
        type: 2,
        timestamp: 1100,
        data: "packed-snapshot",
        isCompressed: true,
        eventIndex: 2,
      },
    ];
    (sdk as unknown as { systemInfo: Record<string, string> }).systemInfo = {
      _sp_browser: "Chrome",
    };

    await sdk.flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("http://thelake.test/v1/traces");
    expect(posts[0]?.headers).toMatchObject({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });

    const payload = JSON.parse(posts[0]!.body);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe(SPAN_NAME);
    const attrs = Object.fromEntries(
      span.attributes.map(
        (a: { key: string; value: { stringValue?: string } }) => [
          a.key,
          a.value.stringValue,
        ],
      ),
    );
    expect(attrs["sp.session.id"]).toBe("ses_flush");
    expect(attrs["sp.observation.type"]).toBe("recording");
    expect(span.events[0].name).toBe(EVENT_NAME);
    const eventsJson = span.events[0].attributes.find(
      (a: { key: string }) => a.key === EVENTS_ATTR,
    ).value.stringValue;
    const events = JSON.parse(eventsJson);
    expect(events).toHaveLength(2);
    expect(events[1].isCompressed).toBe(true);

    expect((sdk as unknown as { events: unknown[] }).events).toEqual([]);
  });

  it("keeps buffer when flush fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      sessionId: "ses_fail",
      manual: true,
    }) as InstanceType<typeof RecordSdk>;

    (sdk as unknown as { events: unknown[] }).events = [
      { type: 4, timestamp: 1, eventIndex: 1 },
    ];
    (sdk as unknown as { systemInfo: Record<string, string> }).systemInfo = {};

    await sdk.flush();
    expect((sdk as unknown as { events: unknown[] }).events).toHaveLength(1);
  });
});
