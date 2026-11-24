import { afterEach, describe, expect, it, vi } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { RecordSdk } from "../src/sdk.js";

const COLLECTOR_URL = "https://collector.example.test/v1/traces";

function setVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

afterEach(() => {
  trace.disable();
  context.disable();
  propagation.disable();
  sessionStorage.clear();
  setVisibilityState("visible");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RecordSdk multi-page unload and sessionStorage spill integration", () => {
  it("dispatches small spans synchronously with keepalive=true on pagehide, spills >28 KiB spans to sessionStorage, and drains them on next page init", async () => {
    const collectorRequests: Array<{ keepalive: boolean | undefined; byteLength: number }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === COLLECTOR_URL) {
          const body = init?.body as Uint8Array;
          collectorRequests.push({
            keepalive: init?.keepalive,
            byteLength: body.byteLength,
          });
        }
        return new Response(null, { status: 200 });
      }),
    );

    const page1 = RecordSdk.init({
      ingestionKey: "spk_test",
      otlpEndpoint: COLLECTOR_URL,
      serviceName: "travel-ota-web",
      sessionId: "session-mpa-1",
      manual: true,
    });

    const tracer = (page1 as unknown as { browserRuntime: { tracer: ReturnType<typeof trace.getTracer> } }).browserRuntime.tracer;
    const uiSpan = tracer.startSpan("softprobe.ui.action");
    uiSpan.setAttribute("sp.ui.action.summary", 'tap button "Search"');
    uiSpan.end();

    const searchFetchSpan = tracer.startSpan("POST");
    searchFetchSpan.setAttribute("http.request.method", "POST");
    searchFetchSpan.setAttribute("http.response.body", "f".repeat(42 * 1024));
    searchFetchSpan.end();

    window.dispatchEvent(new Event("pagehide"));

    // Small UI span must be dispatched synchronously with keepalive=true before any await.
    expect(collectorRequests).toHaveLength(1);
    expect(collectorRequests[0]?.keepalive).toBe(true);
    expect(collectorRequests[0]?.byteLength).toBeLessThanOrEqual(28 * 1024);

    // Oversized search span must be spilled synchronously into sessionStorage.
    const storedRaw = sessionStorage.getItem("_sp_unload_queue:travel-ota-web");
    expect(storedRaw).toBeTruthy();
    const storedEntries = JSON.parse(storedRaw!);
    expect(storedEntries).toHaveLength(1);
    expect(storedEntries[0].byteLength).toBeGreaterThan(28 * 1024);

    // Second pagehide / hidden visibilitychange must not duplicate anything.
    setVisibilityState("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(collectorRequests).toHaveLength(1);

    // Simulate a fresh page load resetting OTel globals while preserving sessionStorage.
    trace.disable();
    context.disable();
    propagation.disable();
    setVisibilityState("visible");
    RecordSdk.init({
      ingestionKey: "spk_test",
      otlpEndpoint: COLLECTOR_URL,
      serviceName: "travel-ota-web",
      manual: true,
    });

    await vi.waitFor(() => expect(collectorRequests).toHaveLength(2));
    expect(collectorRequests[1]?.keepalive).toBe(false);
    expect(collectorRequests[1]?.byteLength).toBeGreaterThan(28 * 1024);
    await vi.waitFor(() =>
      expect(sessionStorage.getItem("_sp_unload_queue:travel-ota-web")).toBeNull(),
    );
  });
});
