import { afterEach, describe, expect, it, vi } from "vitest";

const { rrwebRecordMock } = vi.hoisted(() => ({
  rrwebRecordMock: vi.fn(() => () => {}),
}));

vi.mock("rrweb", () => ({
  pack: (data: unknown) => JSON.stringify(data),
  record: rrwebRecordMock,
}));

import { EVENT_NAME, EVENTS_ATTR, SPAN_NAME } from "../src/otlp.js";
import { RecordSdk } from "../src/sdk.js";

type SdkInternals = {
  events: unknown[];
  systemInfo: Record<string, string>;
  saving: boolean;
  consecutiveFailures: number;
  exportDisabled: boolean;
};

function internals(sdk: InstanceType<typeof RecordSdk>): SdkInternals {
  return sdk as unknown as SdkInternals;
}

describe("RecordSdk.init", () => {
  afterEach(() => {
    sessionStorage.clear();
    rrwebRecordMock.mockClear();
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

  it("applies first-class visible-text masking and blocked-region selectors", () => {
    const sdk = RecordSdk.init({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      maskTextSelector: ".private-copy",
      blockSelector: "#payment-form",
    });

    const recordOptions = rrwebRecordMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(recordOptions.maskAllInputs).toBe(true);
    expect(recordOptions.maskTextSelector).toBe(".private-copy");
    expect(recordOptions.blockSelector).toBe("#payment-form");
    sdk.stop();
  });

  it("keeps a generated session id across SDK initialization in the same tab", async () => {
    const options = {
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      captureId: "capture-tab",
      manual: true,
    };
    const first = RecordSdk.init(options);
    const originalId = first.sessionId;
    expect(sessionStorage.getItem("_sp_session_id:capture-tab")).toBe(originalId);

    const second = RecordSdk.init(options);
    expect(second.sessionId).toBe(originalId);

    await first.setSessionId("application-session");
    const third = RecordSdk.init(options);
    expect(third.sessionId).toBe("application-session");
  });

  it("attempts a keepalive export on pagehide and reports upload status", async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => gate);
    vi.stubGlobal("fetch", fetchMock);
    const statuses: string[] = [];

    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      manual: true,
      onUploadStatus: (status) => statuses.push(status),
    }) as InstanceType<typeof RecordSdk>;
    internals(sdk).systemInfo = {};
    internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: 1 }];
    sdk.record();

    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
    expect(sdk.uploadStatus).toBe("incomplete");
    expect(statuses).toContain("incomplete");

    release(new Response("{}", { status: 200 }));
    await vi.waitFor(() => expect(sdk.uploadStatus).toBe("uploaded"));
  });

  it("reports a failed pagehide upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("offline", { status: 503 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const statuses: string[] = [];
    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      manual: true,
      onUploadStatus: (status) => statuses.push(status),
    }) as InstanceType<typeof RecordSdk>;
    internals(sdk).systemInfo = {};
    internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: 1 }];
    sdk.record();

    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => expect(sdk.uploadStatus).toBe("failed"));
    expect(statuses).toContain("incomplete");
    expect(statuses).toContain("failed");
  });

  it("exports a request span and propagates trace context only to selected origins", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", originalFetch);
    delete (globalThis.fetch as { __sp_sdk_patched_fetch?: boolean })
      .__sp_sdk_patched_fetch;
    vi.stubGlobal("location", {
      href: "https://app.example.com/chat",
      origin: "https://app.example.com",
    });

    RecordSdk.init({
      apiKey: "agent-key",
      baseUrl: "https://collector.example.com",
      captureId: "capture-request",
      sessionId: "session-request",
      apiOrigins: ["https://api.example.com"],
      manual: true,
    });

    await fetch("https://api.example.com/api/orders?token=private");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    const requestHeaders = new Headers(calls[0]?.init?.headers);
    const [version, traceId, spanId] = requestHeaders.get("traceparent")!.split("-");
    expect(version).toBe("00");
    expect(requestHeaders.has("x-sp-session-id")).toBe(false);
    expect(requestHeaders.has("x-softprobe-capture-id")).toBe(false);

    const exportCall = calls.find((call) => call.url.endsWith("/v1/traces"));
    expect(exportCall).toBeDefined();
    expect(exportCall?.init?.keepalive).toBe(true);
    expect(new Headers(exportCall?.init?.headers).get("x-softprobe-capture-id"))
      .toBe("capture-request");
    const envelope = JSON.parse(String(exportCall?.init?.body));
    const span = envelope.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe(traceId);
    expect(span.spanId).toBe(spanId);
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(attrs["sp.capture.id"]).toBe("capture-request");
    expect(attrs["sp.session.id"]).toBe("session-request");
    expect(attrs["url.path"]).toBe("/api/orders");
    expect(String(exportCall?.init?.body)).not.toContain("private");
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
      apiKey: "agent-ingest-key",
      baseUrl: "http://thelake.test",
      captureId: "capture-demo",
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
      Authorization: "Bearer agent-ingest-key",
      "Content-Type": "application/json",
      "X-Softprobe-Capture-ID": "capture-demo",
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
    expect(attrs["sp.capture.id"]).toBe("capture-demo");
    expect(attrs["sp.observation.type"]).toBe("recording");
    expect(span.events[0].name).toBe(EVENT_NAME);
    expect(posts[0]!.body).not.toContain("agent-ingest-key");
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
  // ——— 导出失败的退避与熔断 ———
  // 回归背景(2026-08-25 现场):collector 不可达时,原实现每 5 秒原样重发同一批事件,
  // 失败 429 次没停过 —— 控制台被刷爆、主线程每轮白做一次序列化+压缩,页面明显卡。
  // 下面三条在旧实现上都是红的。

  function failingSdk(sessionId: string) {
    const sdk = RecordSdk.init({
      publicKey: "token",
      baseUrl: "http://thelake.test",
      sessionId,
      manual: true,
    }) as InstanceType<typeof RecordSdk>;
    internals(sdk).systemInfo = {};
    return sdk;
  }

  it("logs once per failure streak instead of once per attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sdk = failingSdk("ses_streak");

    for (let i = 0; i < 3; i += 1) {
      internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: i + 1 }];
      await sdk.flush();
    }

    // 旧实现:每次失败都 console.error 一条 → 3。
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("gives up after a failure streak: drops the buffer and stops exporting", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sdk = failingSdk("ses_giveup");

    for (let i = 0; i < 5; i += 1) {
      internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: i + 1 }];
      await sdk.flush();
    }

    // 旧实现:事件被 unshift 回去,永远留着 → 长度 1。
    expect(internals(sdk).exportDisabled).toBe(true);
    expect(internals(sdk).events).toHaveLength(0);

    // 熔断后不许再打网络,也不许再吞掉新事件。
    const callsBefore = fetchMock.mock.calls.length;
    internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: 99 }];
    await sdk.flush();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(internals(sdk).events).toHaveLength(1);
  });

  it("resets the failure streak after a successful export", async () => {
    let healthy = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        healthy
          ? new Response("{}", { status: 200 })
          : new Response("nope", { status: 503 }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sdk = failingSdk("ses_recover");

    internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: 1 }];
    await sdk.flush();
    expect(internals(sdk).consecutiveFailures).toBe(1);

    healthy = true;
    internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: 2 }];
    await sdk.flush();

    // 旧实现:根本没有这个计数 → undefined。
    expect(internals(sdk).consecutiveFailures).toBe(0);
    expect(internals(sdk).exportDisabled).toBe(false);
  });
  it("refuses to re-arm recording after giving up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sdk = failingSdk("ses_rearm");

    for (let i = 0; i < 5; i += 1) {
      internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: i + 1 }];
      await sdk.flush();
    }
    expect(internals(sdk).exportDisabled).toBe(true);

    // 宿主每次路由变化都会调 record();熔断后必须拒绝,否则每导航一次白起一轮采集。
    expect(sdk.record()).toBeNull();
  });
});
