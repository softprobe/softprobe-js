import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  const spans: Array<{
    name: string;
    attributes: Record<string, unknown>;
    events: Array<{ name: string; attributes: Record<string, unknown>; time: Date }>;
    status?: { code: number };
    ended: boolean;
  }> = [];
  const state: {
    spans: typeof spans;
    sessionId: string;
    active: boolean;
    idleGate?: Promise<void>;
    releaseIdle?: () => void;
    exportError?: Error;
    exportGate?: Promise<void>;
    releaseExport?: () => void;
    runtimeOptions?: unknown;
    createBrowserRuntime: ReturnType<typeof vi.fn>;
    runtime: {
      tracer: { startSpan: ReturnType<typeof vi.fn> };
      hasPendingTelemetry: ReturnType<typeof vi.fn>;
      waitForIdle: ReturnType<typeof vi.fn>;
      forceFlush: ReturnType<typeof vi.fn>;
      setSessionId: ReturnType<typeof vi.fn>;
      shutdown: ReturnType<typeof vi.fn>;
    };
  } = {
    spans,
    sessionId: "",
    active: false,
    createBrowserRuntime: vi.fn(),
    runtime: undefined as never,
  };
  const runtime = {
    tracer: {
      startSpan: vi.fn((name: string, options: { attributes?: Record<string, unknown> } = {}) => {
        const span = {
          name,
          attributes: {
            ...(options.attributes ?? {}),
            "session.id": state.sessionId,
            "sp.session.id": state.sessionId,
          },
          events: [] as typeof spans[number]["events"],
          ended: false,
          addEvent(eventName: string, attributes: Record<string, unknown>, time: Date) {
            this.events.push({ name: eventName, attributes, time });
          },
          setAttribute(key: string, value: unknown) {
            this.attributes[key] = value;
            return this;
          },
          setStatus(status: { code: number }) {
            this.status = status;
            return this;
          },
          end() {
            this.ended = true;
          },
        };
        spans.push(span);
        return span;
      }),
    },
    hasPendingTelemetry: vi.fn(() => state.active),
    waitForIdle: vi.fn(async () => {
      if (state.idleGate) await state.idleGate;
      state.active = false;
    }),
    forceFlush: vi.fn(async () => {
      if (state.exportGate) await state.exportGate;
      if (state.exportError) {
        const error = state.exportError;
        state.exportError = undefined;
        throw error;
      }
    }),
    setSessionId: vi.fn((sessionId: string) => {
      state.sessionId = sessionId;
    }),
    shutdown: vi.fn(async () => undefined),
  };
  state.runtime = runtime;
  state.createBrowserRuntime.mockImplementation((options: unknown, sessionState: { getSessionId(): string }) => {
    state.runtimeOptions = options;
    state.sessionId = sessionState.getSessionId();
    return runtime;
  });
  return state;
});

vi.mock("../src/browser-runtime.js", () => ({
  createBrowserRuntime: testState.createBrowserRuntime,
}));

const { rrwebRecordMock } = vi.hoisted(() => ({
  rrwebRecordMock: vi.fn(() => () => undefined),
}));

vi.mock("rrweb", () => ({
  pack: (data: unknown) => JSON.stringify(data),
  record: rrwebRecordMock,
}));

import { RecordSdk } from "../src/sdk.js";

type SdkInternals = {
  events: unknown[];
  systemInfo: Record<string, string> | null;
  saving: boolean;
  consecutiveFailures: number;
  exportDisabled: boolean;
  batchIndex: number;
};

function internals(sdk: InstanceType<typeof RecordSdk>): SdkInternals {
  return sdk as unknown as SdkInternals;
}

function recordingSdk(extra: Record<string, unknown> = {}) {
  return RecordSdk.init({
    apiKey: "agent-key",
    baseUrl: "https://collector.example.test",
    sessionId: "session-recording",
    manual: true,
    ...extra,
  }) as InstanceType<typeof RecordSdk>;
}

function resetTestState(): void {
  testState.spans.length = 0;
  testState.sessionId = "";
  testState.active = false;
  testState.idleGate = undefined;
  testState.releaseIdle = undefined;
  testState.exportError = undefined;
  testState.exportGate = undefined;
  testState.releaseExport = undefined;
  testState.runtimeOptions = undefined;
  testState.createBrowserRuntime.mockClear();
  for (const mock of Object.values(testState.runtime)) {
    if (typeof mock === "object" && mock !== null) {
      for (const value of Object.values(mock)) {
        if (typeof value === "function" && "mockClear" in value) value.mockClear();
      }
      continue;
    }
    if (typeof mock === "function") mock.mockClear();
  }
  testState.runtime.tracer.startSpan.mockClear();
  testState.runtime.hasPendingTelemetry.mockImplementation(() => testState.active);
  testState.runtime.waitForIdle.mockImplementation(async () => {
    if (testState.idleGate) await testState.idleGate;
    testState.active = false;
  });
  testState.runtime.forceFlush.mockImplementation(async () => {
    if (testState.exportGate) await testState.exportGate;
    if (testState.exportError) {
      const error = testState.exportError;
      testState.exportError = undefined;
      throw error;
    }
  });
  testState.runtime.setSessionId.mockImplementation((sessionId: string) => {
    testState.sessionId = sessionId;
  });
  testState.runtime.shutdown.mockResolvedValue(undefined);
  testState.runtime.tracer.startSpan.mockImplementation((name: string, options: { attributes?: Record<string, unknown> } = {}) => {
    const span = {
      name,
      attributes: {
        ...(options.attributes ?? {}),
        "session.id": testState.sessionId,
        "sp.session.id": testState.sessionId,
      },
      events: [] as typeof testState.spans[number]["events"],
      ended: false,
      addEvent(eventName: string, attributes: Record<string, unknown>, time: Date) {
        this.events.push({ name: eventName, attributes, time });
      },
      setAttribute(key: string, value: unknown) {
        this.attributes[key] = value;
        return this;
      },
      setStatus(status: { code: number }) {
        this.status = status;
        return this;
      },
      end() {
        this.ended = true;
      },
    };
    testState.spans.push(span);
    return span;
  });
  testState.createBrowserRuntime.mockImplementation((options: unknown, sessionState: { getSessionId(): string }) => {
    testState.runtimeOptions = options;
    testState.sessionId = sessionState.getSessionId();
    return testState.runtime;
  });
}

describe("RecordSdk", () => {
  afterEach(() => {
    sessionStorage.clear();
    rrwebRecordMock.mockClear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetTestState();
  });

  it("soft-disables when credentials are missing and otherwise requires credentials", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disabled = RecordSdk.init({ softDisable: true } as never);
    expect(disabled.enabled).toBe(false);
    expect(disabled.record()).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(testState.createBrowserRuntime).not.toHaveBeenCalled();

    expect(() => RecordSdk.init({ softDisable: false } as never)).toThrow(/publicKey and baseUrl/);
  });

  it("uploads to production TheLake when baseUrl is omitted and stays off for a blank baseUrl", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    RecordSdk.init({
      apiKey: "agent-key",
      serviceName: "travel-ota-web",
      manual: true,
    });
    expect(testState.runtimeOptions).toMatchObject({
      otlpEndpoint: "https://explorer.softprobe.ai/api/thelake/v1/traces",
      httpBodyCapture: {},
    });

    RecordSdk.init({
      apiKey: "agent-key",
      httpBodyCapture: false,
      manual: true,
    });
    expect(testState.runtimeOptions).toMatchObject({
      httpBodyCapture: undefined,
    });

    const disabled = RecordSdk.init({
      apiKey: "agent-key",
      baseUrl: "",
      manual: true,
    });
    expect(disabled.enabled).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a generated session id in the tab and supports session switches", async () => {
    const options = {
      apiKey: "agent-key",
      baseUrl: "https://collector.example.test",
      serviceName: "travel-ota-web",
      manual: true,
    };
    const first = RecordSdk.init(options);
    expect(testState.createBrowserRuntime).toHaveBeenCalled();
    const originalId = first.sessionId;
    expect(sessionStorage.getItem("_sp_session_id:travel-ota-web")).toBe(originalId);
    expect((RecordSdk.init(options)).sessionId).toBe(originalId);

    await first.setSessionId("application-session");
    expect(testState.runtime.setSessionId).toHaveBeenCalledWith("application-session");
    expect(RecordSdk.init(options).sessionId).toBe("application-session");
  });

  it("discovers host session id from sessionStorage and adopts runtime-discovered session ids", () => {
    sessionStorage.setItem("demo-ota.travel.sessionId", "ses_host_initial");
    const sdk = RecordSdk.init({
      apiKey: "agent-key",
      baseUrl: "https://collector.example.test",
      manual: true,
    });
    expect(sdk.sessionId).toBe("ses_host_initial");

    const runtimeOptions = testState.runtimeOptions as { onSessionId?: (id: string) => void };
    expect(typeof runtimeOptions.onSessionId).toBe("function");
    runtimeOptions.onSessionId?.("ses_created_from_api");
    expect(sdk.sessionId).toBe("ses_created_from_api");
    expect(testState.runtime.setSessionId).toHaveBeenCalledWith("ses_created_from_api");
  });

  it("keeps session storage independent for different service names", () => {
    const first = RecordSdk.init({ apiKey: "agent-key", baseUrl: "https://collector.example.test", serviceName: "travel-ota-web", manual: true });
    const second = RecordSdk.init({ apiKey: "agent-key", baseUrl: "https://collector.example.test", serviceName: "admin-web", manual: true });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(sessionStorage.getItem("_sp_session_id:travel-ota-web")).toBe(first.sessionId);
    expect(sessionStorage.getItem("_sp_session_id:admin-web")).toBe(second.sessionId);
  });

  it("applies rrweb privacy options and stops recording through the returned handle", () => {
    const sdk = RecordSdk.init({
      apiKey: "agent-key",
      baseUrl: "https://collector.example.test",
      maskTextSelector: ".private-copy",
      blockSelector: "#payment-form",
    });
    const options = rrwebRecordMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.maskAllInputs).toBe(true);
    expect(options.maskTextSelector).toBe(".private-copy");
    expect(options.blockSelector).toBe("#payment-form");
    sdk.stop();
    expect(rrwebRecordMock).toHaveBeenCalledTimes(1);
  });

  it("exports rrweb batches as OTel recording spans with their event payload", async () => {
    const sdk = recordingSdk({ tags: { userId: "user-7", plan: "gold" } });
    const internal = internals(sdk);
    internal.systemInfo = { _sp_browser: "Chrome" };
    internal.events = [
      { type: 4, timestamp: 1000, eventIndex: 1 },
      { type: 2, timestamp: 1100, data: "packed-snapshot", isCompressed: true, eventIndex: 2 },
    ];

    await expect(sdk.flush()).resolves.toBe(true);

    const span = testState.spans[0]!;
    expect(span.name).toBe("softprobe.web.recording");
    expect(span.attributes).toMatchObject({
      "sp.session.id": "session-recording",
      "session.id": "session-recording",
      "sp.observation.type": "recording",
      "sp.recording.batch_index": 0,
      _sp_browser: "Chrome",
      userId: "user-7",
      plan: "gold",
    });
    expect(span.events).toHaveLength(1);
    expect(span.events[0]?.name).toBe("sp.recording.batch");
    expect(JSON.parse(String(span.events[0]?.attributes["sp.recording.events"]))).toMatchObject([
      { eventIndex: 1 },
      { eventIndex: 2, isCompressed: true },
    ]);
    expect(span.ended).toBe(true);
    expect(internal.events).toEqual([]);
    expect(internal.batchIndex).toBe(1);
    expect(sdk.uploadStatus).toBe("uploaded");
  });

  it("preserves events arriving while an OTel export is in flight", async () => {
    let release!: () => void;
    testState.exportGate = new Promise<void>((resolve) => { release = resolve; });
    const sdk = recordingSdk();
    const internal = internals(sdk);
    internal.systemInfo = {};
    internal.events = [{ type: 4, timestamp: 1, eventIndex: 1 }];

    const flushing = sdk.flush();
    await vi.waitFor(() => expect(internal.saving).toBe(true));
    internal.events.push({ type: 3, timestamp: 2, eventIndex: 2 });
    release();

    await expect(flushing).resolves.toBe(true);
    expect(internal.events).toEqual([{ type: 3, timestamp: 2, eventIndex: 2 }]);
    expect(JSON.parse(String(testState.spans[0]?.events[0]?.attributes["sp.recording.events"])))
      .toMatchObject([{ eventIndex: 1 }]);
  });

  it("restores the batch and backs off after an OTel export failure", async () => {
    const sdk = recordingSdk();
    const internal = internals(sdk);
    internal.systemInfo = {};
    internal.events = [{ type: 4, timestamp: 1, eventIndex: 1 }];
    testState.exportError = new Error("offline");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sdk.flush()).resolves.toBe(false);
    expect(internal.events).toEqual([{ type: 4, timestamp: 1, eventIndex: 1 }]);
    expect(internal.consecutiveFailures).toBe(1);
    expect(sdk.uploadStatus).toBe("failed");
  });

  it("opens the export circuit after five consecutive failures", async () => {
    const sdk = recordingSdk();
    const internal = internals(sdk);
    internal.systemInfo = {};
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (let index = 0; index < 5; index += 1) {
      internal.events = [{ type: 4, timestamp: index + 1, eventIndex: index + 1 }];
      testState.exportError = new Error("offline");
      await sdk.flush();
    }
    expect(internal.exportDisabled).toBe(true);
    expect(internal.events).toEqual([]);
    const starts = testState.runtime.tracer.startSpan.mock.calls.length;
    await expect(sdk.flush()).resolves.toBe(false);
    expect(testState.runtime.tracer.startSpan).toHaveBeenCalledTimes(starts);
  });

  it("drains active spans before changing the session id", async () => {
    let release!: () => void;
    testState.active = true;
    testState.idleGate = new Promise<void>((resolve) => { release = resolve; });
    const sdk = recordingSdk({ sessionId: "session-before" });

    const switching = sdk.setSessionId("session-after");
    expect(sdk.sessionId).toBe("session-before");
    expect(testState.runtime.setSessionId).not.toHaveBeenCalled();
    release();
    await switching;

    expect(testState.runtime.setSessionId).toHaveBeenCalledWith("session-after");
    expect(sdk.sessionId).toBe("session-after");
  });

  it("reports an incomplete pagehide flush until OTel confirms export", async () => {
    let release!: () => void;
    testState.exportGate = new Promise<void>((resolve) => { release = resolve; });
    const statuses: string[] = [];
    const sdk = recordingSdk({ onUploadStatus: (status: string) => statuses.push(status) });
    internals(sdk).systemInfo = {};
    internals(sdk).events = [{ type: 4, timestamp: 1, eventIndex: 1 }];
    sdk.record();

    window.dispatchEvent(new Event("pagehide"));
    expect(sdk.uploadStatus).toBe("incomplete");
    release();
    await vi.waitFor(() => expect(sdk.uploadStatus).toBe("uploaded"));
    expect(statuses).toContain("incomplete");
  });

  it("auto-initializes from a script tag with data-api-key", async () => {
    const { autoInitFromScript } = await import("../src/browser.js");
    const script = document.createElement("script");
    script.dataset.apiKey = "spk_script_tag";
    document.head.appendChild(script);
    try {
      const session = autoInitFromScript(document);
      expect(session?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(testState.runtimeOptions).toMatchObject({
        apiKey: "spk_script_tag",
        otlpEndpoint: "https://explorer.softprobe.ai/api/thelake/v1/traces",
        httpBodyCapture: {},
      });
    } finally {
      script.remove();
    }
  });
});
