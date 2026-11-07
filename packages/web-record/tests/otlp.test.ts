import { describe, expect, it } from "vitest";
import {
  buildClientRequestExport,
  buildRecordingExport,
  EVENT_NAME,
  EVENTS_ATTR,
  msToUnixNano,
  SPAN_NAME,
} from "../src/otlp.js";

describe("buildRecordingExport", () => {
  it("emits OTLP resourceSpans with recording attrs and batch event", () => {
    const events = [
      { type: 2, timestamp: 1_000, data: { foo: 1 }, eventIndex: 1 },
      {
        type: 2,
        timestamp: 2_000,
        data: "packed",
        isCompressed: true,
        eventIndex: 2,
      },
    ];
    const body = buildRecordingExport({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      sessionId: "ses_abc",
      batchIndex: 3,
      startTimeUnixNano: msToUnixNano(1_000),
      endTimeUnixNano: msToUnixNano(2_000),
      events,
      attributes: {
        _sp_browser: "Chrome",
        userId: "u1",
        skip: null,
      },
      serviceName: "softprobe-web",
      environment: "test",
    });

    const span = (body.resourceSpans as any[])[0].scopeSpans[0].spans[0];
    expect(span.name).toBe(SPAN_NAME);
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);

    const keys = Object.fromEntries(
      span.attributes.map((a: { key: string; value: { stringValue?: string; intValue?: string } }) => [
        a.key,
        a.value.stringValue ?? a.value.intValue,
      ]),
    );
    expect(keys["sp.session.id"]).toBe("ses_abc");
    expect(keys["sp.capture.source"]).toBe("browser");
    expect(keys).not.toHaveProperty("sp.capture.id");
    expect(keys["sp.observation.type"]).toBe("recording");
    expect(keys["sp.recording.batch_index"]).toBe("3");
    expect(keys._sp_browser).toBe("Chrome");
    expect(keys.userId).toBe("u1");
    expect(keys.skip).toBeUndefined();

    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe(EVENT_NAME);
    const eventAttrs = Object.fromEntries(
      span.events[0].attributes.map((a: { key: string; value: { stringValue: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(JSON.parse(eventAttrs[EVENTS_ATTR])).toEqual(events);

    const resource = (body.resourceSpans as any[])[0].resource.attributes;
    const resourceKeys = Object.fromEntries(
      resource.map((a: { key: string; value: { stringValue: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(resourceKeys["service.name"]).toBe("softprobe-web");
    expect(resourceKeys["deployment.environment.name"]).toBe("test");
  });

  it("preserves compressed FullSnapshot flag in JSON payload", () => {
    const events = [
      {
        type: 2,
        timestamp: 10,
        data: "abc",
        isCompressed: true,
        eventIndex: 1,
      },
    ];
    const body = buildRecordingExport({
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      sessionId: "s",
      batchIndex: 0,
      startTimeUnixNano: "0",
      endTimeUnixNano: "1",
      events,
      attributes: {},
    });
    const attr = (body.resourceSpans as any[])[0].scopeSpans[0].spans[0]
      .events[0].attributes[0];
    expect(JSON.parse(attr.value.stringValue)[0].isCompressed).toBe(true);
    const span = (body.resourceSpans as any[])[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((item: { key: string; value: { stringValue?: string } }) => [
        item.key,
        item.value.stringValue,
      ]),
    );
    expect(attrs["sp.capture.source"]).toBe("browser");
  });
});

describe("msToUnixNano", () => {
  it("converts ms to nanos as string", () => {
    expect(msToUnixNano(1_721_390_400_000)).toBe("1721390400000000000");
  });
});

describe("buildClientRequestExport", () => {
  it("keeps the selected API request in the same session and omits query data", () => {
    const payload = buildClientRequestExport({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      sessionId: "session-1",
      method: "POST",
      scheme: "https",
      serverAddress: "api.example.test",
      path: "/api/flights/search",
      statusCode: 200,
      failed: false,
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2000000",
      serviceName: "travel-ota",
    });
    const span = (payload.resourceSpans as any[])[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: { stringValue?: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );

    expect(span.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(span.spanId).toBe("0123456789abcdef");
    expect(span.kind).toBe(3);
    expect(attrs["sp.session.id"]).toBe("session-1");
    expect(attrs["sp.capture.source"]).toBe("browser");
    expect(attrs).not.toHaveProperty("sp.capture.id");
    expect(attrs["url.path"]).toBe("/api/flights/search");
    expect(JSON.stringify(payload)).not.toContain("?token=");
    expect(span.status.code).toBe(1);
  });
});
