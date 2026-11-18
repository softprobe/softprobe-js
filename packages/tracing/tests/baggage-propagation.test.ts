import { describe, expect, it } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  BaggageSessionSpanProcessor,
  SoftprobeClient,
  injectTraceHeaders,
  withAttributes,
  withExtractedHeaders,
} from "../src/index.js";

describe("W3C baggage session propagation", () => {
  it("stamps sp.session.id from incoming W3C baggage onto Softprobe and raw OTel child spans", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      ingestionKey: "spk_test",
      otlp: { tracesEndpoint: "http://127.0.0.1:8091/v1/traces" },
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });

    const incomingTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const incomingSpanId = "00f067aa0ba902b7";

    await withExtractedHeaders(
      {
        traceparent: `00-${incomingTraceId}-${incomingSpanId}-01`,
        baggage: "other=1, sp.session.id=sess_baggage_alpha;ttl=60",
      },
      async () => {
        await client.withObservation({ name: "handle-request" }, async () => {
          const child = client.tracer.startSpan("postgres.query");
          child.end();
        });
      },
    );

    await client.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(incomingTraceId);
      expect(span.attributes["sp.session.id"]).toBe("sess_baggage_alpha");
      expect(span.attributes["gen_ai.conversation.id"]).toBe(
        "sess_baggage_alpha",
      );
    }
    await client.shutdown();
  });

  it("preserves explicit sessionId over incoming W3C baggage", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      ingestionKey: "spk_test",
      otlp: { tracesEndpoint: "http://127.0.0.1:8091/v1/traces" },
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });

    withExtractedHeaders(
      { baggage: "sp.session.id=sess_from_baggage" },
      () => {
        const obs = client.startObservation({
          name: "explicit-wins",
          sessionId: "sess_explicit_override",
        });
        obs.end();

        const rawExplicit = client.tracer.startSpan("raw-explicit", {
          attributes: { "sp.session.id": "sess_raw_explicit" },
        });
        rawExplicit.end();
      },
    );

    await client.forceFlush();
    const byName = Object.fromEntries(
      exporter.getFinishedSpans().map((s) => [s.name, s]),
    );
    expect(byName["explicit-wins"]?.attributes["sp.session.id"]).toBe(
      "sess_explicit_override",
    );
    expect(byName["raw-explicit"]?.attributes["sp.session.id"]).toBe(
      "sess_raw_explicit",
    );
    await client.shutdown();
  });

  it("ignores malformed or oversized baggage session ids and never invents a session id", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      ingestionKey: "spk_test",
      otlp: { tracesEndpoint: "http://127.0.0.1:8091/v1/traces" },
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });

    withExtractedHeaders(
      { baggage: `sp.session.id=${"x".repeat(129)}` },
      () => {
        const oversized = client.startObservation({ name: "oversized" });
        oversized.end();
      },
    );

    withExtractedHeaders({ baggage: "sp.session.id=bad%20space" }, () => {
      const whitespace = client.startObservation({ name: "whitespace" });
      whitespace.end();
    });

    const plain = client.startObservation({ name: "no-session" });
    plain.end();

    expect(BaggageSessionSpanProcessor).toBeDefined();
    await client.forceFlush();

    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes["sp.session.id"]).toBeUndefined();
      expect(span.attributes["gen_ai.conversation.id"]).toBeUndefined();
    }
    await client.shutdown();
  });

  it("injects W3C traceparent and sp.session.id baggage on outbound headers", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      ingestionKey: "spk_test",
      otlp: { tracesEndpoint: "http://127.0.0.1:8091/v1/traces" },
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });

    let fromWithAttributes: Record<string, string> = {};
    withAttributes({ sessionId: "sess_attr_outbound" }, () => {
      const rawChild = client.tracer.startSpan("raw.child");
      rawChild.end();
      fromWithAttributes = injectTraceHeaders();
    });
    expect(fromWithAttributes.baggage).toContain(
      "sp.session.id=sess_attr_outbound",
    );

    let fromObservation: Record<string, string> = {};
    await client.withObservation(
      { name: "outbound-call", sessionId: "sess_obs_outbound" },
      async (obs) => {
        fromObservation = injectTraceHeaders({
          "x-custom": "keep",
          Baggage: "tenant=acme;p=1",
        });
        expect(fromObservation.traceparent).toContain(obs.traceId);
      },
    );
    expect(fromObservation["x-custom"]).toBe("keep");
    expect(fromObservation.Baggage).toBeUndefined();
    expect(fromObservation.baggage).toContain("tenant=acme;p=1");
    expect(fromObservation.baggage).toContain(
      "sp.session.id=sess_obs_outbound",
    );

    await client.forceFlush();
    const rawChild = exporter
      .getFinishedSpans()
      .find((s) => s.name === "raw.child");
    expect(rawChild?.attributes["sp.session.id"]).toBe("sess_attr_outbound");
    await client.shutdown();
  });
});
