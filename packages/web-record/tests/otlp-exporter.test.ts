import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { BrowserOtlpProtoSpanExporter } from "../src/otlp-exporter.js";

function makeSpan(name: string, bodySizeBytes = 0): ReadableSpan {
  const attributes: Record<string, string> = {
    "sp.session.id": "session-123",
  };
  if (bodySizeBytes > 0) {
    attributes["http.response.body"] = "x".repeat(bodySizeBytes);
  }
  return {
    name,
    kind: 2,
    spanContext: () => ({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    }),
    startTime: [1700000000, 0],
    endTime: [1700000000, 1000000],
    status: { code: 1 },
    attributes,
    links: [],
    events: [],
    duration: [0, 1000000],
    ended: true,
    resource: { attributes: { "service.name": "travel-ota-web" } },
    instrumentationScope: { name: "softprobe.web.record", version: "0.1.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BrowserOtlpProtoSpanExporter unload path", () => {
  it("sends small trace spans with keepalive=true while spilling oversized recording spans", async () => {
    const fetchCalls: Array<{ keepalive: boolean | undefined; byteLength: number }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as Uint8Array;
        fetchCalls.push({ keepalive: init?.keepalive, byteLength: body.byteLength });
        return new Response(null, { status: 200 });
      }),
    );

    const exporter = new BrowserOtlpProtoSpanExporter({
      url: "https://collector.example.test/v1/traces",
      ingestionKey: "spk_test",
    });

    const spilled: Uint8Array[] = [];
    const postSpan = makeSpan("POST", 1024);
    const uiSpan = makeSpan("softprobe.ui.action", 256);
    const oversizedRecording = makeSpan("softprobe.web.recording", 40 * 1024);

    exporter.exportUnloadSync([oversizedRecording, postSpan, uiSpan], (bytes) => {
      spilled.push(bytes);
      return true;
    });

    await exporter.forceFlush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.keepalive).toBe(true);
    expect(fetchCalls[0]?.byteLength).toBeLessThanOrEqual(28 * 1024);
    expect(spilled).toHaveLength(1);
    expect(spilled[0]?.byteLength).toBeGreaterThan(28 * 1024);
  });

  it("binary-splits mixed trace spans so small spans still use keepalive and only oversized spans spill", async () => {
    const fetchCalls: Array<{ keepalive: boolean | undefined; byteLength: number }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as Uint8Array;
        fetchCalls.push({ keepalive: init?.keepalive, byteLength: body.byteLength });
        return new Response(null, { status: 200 });
      }),
    );

    const exporter = new BrowserOtlpProtoSpanExporter({
      url: "https://collector.example.test/v1/traces",
      ingestionKey: "spk_test",
    });

    const spilled: Uint8Array[] = [];
    const smallAction = makeSpan("softprobe.ui.action", 128);
    const hugeSearchFetch = makeSpan("POST", 45 * 1024);

    exporter.exportUnloadSync([smallAction, hugeSearchFetch], (bytes) => {
      spilled.push(bytes);
      return true;
    });

    await exporter.forceFlush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.keepalive).toBe(true);
    expect(spilled).toHaveLength(1);
    expect(spilled[0]?.byteLength).toBeGreaterThan(28 * 1024);
  });

  it("spills keepalive payload if fetch rejects and replays serialized bytes via sendSerialized", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("keepalive quota exceeded"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = new BrowserOtlpProtoSpanExporter({
      url: "https://collector.example.test/v1/traces",
      ingestionKey: "spk_test",
    });

    const spilled: Uint8Array[] = [];
    exporter.exportUnloadSync([makeSpan("POST", 512)], (bytes) => {
      spilled.push(bytes);
      return true;
    });

    await vi.waitFor(() => expect(spilled).toHaveLength(1));

    const ok = await exporter.sendSerialized(spilled[0]!);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(false);
    expect(ExportResultCode.SUCCESS).toBe(0);
  });
});
