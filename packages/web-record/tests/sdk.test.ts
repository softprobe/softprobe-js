import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("rrweb", () => ({
  pack: (data: unknown) => JSON.stringify(data),
  record: () => () => {},
}));

import { EVENT_NAME, EVENTS_ATTR, SPAN_NAME } from "../src/otlp.js";
import { RecordSdk } from "../src/sdk.js";

type SdkInternals = {
  events: unknown[];
  systemInfo: Record<string, string>;
  saving: boolean;
};

function internals(sdk: InstanceType<typeof RecordSdk>): SdkInternals {
  return sdk as unknown as SdkInternals;
}

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

  it("honors explicit sessionId and setSessionId", async () => {
    const sdk = RecordSdk.init({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      sessionId: "ses_open",
      manual: true,
    });
    expect(sdk.enabled).toBe(true);
    expect(sdk.sessionId).toBe("ses_open");
    await sdk.setSessionId("ses_next");
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
    internals(sdk).events = [
      { type: 4, timestamp: 1000, data: { href: "http://x" }, eventIndex: 1 },
      {
        type: 2,
        timestamp: 1100,
        data: "packed-snapshot",
        isCompressed: true,
        eventIndex: 2,
      },
    ];
    internals(sdk).systemInfo = {
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

    expect(internals(sdk).events).toEqual([]);
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

    internals(sdk).events = [
      { type: 4, timestamp: 1, eventIndex: 1 },
    ];
    internals(sdk).systemInfo = {};

    await sdk.flush();
    expect(internals(sdk).events).toHaveLength(1);
  });

  it("preserves events recorded while export is in flight", async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const posts: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        posts.push(String(init?.body ?? ""));
        return gate;
      }),
    );

    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      sessionId: "ses_race",
      manual: true,
    }) as InstanceType<typeof RecordSdk>;

    internals(sdk).systemInfo = {};
    internals(sdk).events = [
      { type: 4, timestamp: 1, eventIndex: 1 },
    ];

    const flushPromise = sdk.flush();
    // While export is awaiting fetch, a new event arrives.
    await vi.waitFor(() => expect(internals(sdk).saving).toBe(true));
    internals(sdk).events.push({ type: 3, timestamp: 2, eventIndex: 2 });

    release(new Response("{}", { status: 200 }));
    await flushPromise;

    expect(posts).toHaveLength(1);
    const exported = JSON.parse(
      JSON.parse(posts[0]!).resourceSpans[0].scopeSpans[0].spans[0].events[0]
        .attributes.find((a: { key: string }) => a.key === EVENTS_ATTR).value
        .stringValue,
    );
    expect(exported).toHaveLength(1);
    expect(exported[0].eventIndex).toBe(1);
    // Event that arrived during await must still be buffered.
    expect(internals(sdk).events).toEqual([
      { type: 3, timestamp: 2, eventIndex: 2 },
    ]);
  });

  it("prepends the batch back when flush fails mid-flight with new events", async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async () => gate));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      sessionId: "ses_fail_race",
      manual: true,
    }) as InstanceType<typeof RecordSdk>;

    internals(sdk).systemInfo = {};
    internals(sdk).events = [
      { type: 4, timestamp: 1, eventIndex: 1 },
    ];

    const flushPromise = sdk.flush();
    await vi.waitFor(() => expect(internals(sdk).saving).toBe(true));
    internals(sdk).events.push({ type: 3, timestamp: 2, eventIndex: 2 });

    release(new Response("nope", { status: 503 }));
    await flushPromise;

    expect(internals(sdk).events).toEqual([
      { type: 4, timestamp: 1, eventIndex: 1 },
      { type: 3, timestamp: 2, eventIndex: 2 },
    ]);
  });

  it("flushes buffered events under the old session id before setSessionId", async () => {
    const sessionIds: string[] = [];
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
        const sid = attrs.find(
          (a: { key: string }) => a.key === "sp.session.id",
        ).value.stringValue;
        sessionIds.push(sid);
        return gate;
      }),
    );

    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      sessionId: "ses_old",
      manual: true,
    }) as InstanceType<typeof RecordSdk>;

    internals(sdk).systemInfo = {};
    internals(sdk).events = [
      { type: 4, timestamp: 1, eventIndex: 1 },
    ];

    sdk.setSessionId("ses_new");
    // Session must stay old until the drain flush completes.
    expect(sdk.sessionId).toBe("ses_old");
    await vi.waitFor(() => expect(internals(sdk).saving).toBe(true));

    release(new Response("{}", { status: 200 }));
    await vi.waitFor(() => expect(sdk.sessionId).toBe("ses_new"));

    expect(sessionIds).toEqual(["ses_old"]);
    expect(internals(sdk).events).toEqual([]);
  });
});
