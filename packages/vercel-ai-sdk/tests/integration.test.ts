import http from "node:http";
import {
  context as otelContext,
  propagation as otelPropagation,
  trace as otelTrace,
} from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { SoftprobeClient, withAttributes } from "@softprobe/tracing";
import { describe, expect, it } from "vitest";
import {
  createSoftprobeObservationAttributes,
  initVercelAiTelemetry,
  installIncomingHttpContextPropagation,
  SoftprobeVercelAiSdkIntegration,
} from "../src/integration.js";

describe("createSoftprobeObservationAttributes", () => {
  it("maps language model spans to generation and links prompts", () => {
    const attrs = createSoftprobeObservationAttributes({
      spanType: "languageModel",
      runtimeContext: {
        route: "weather",
        softprobePrompt: { name: "weather-chat", version: 3 },
      },
    });
    expect(attrs["sp.observation.type"]).toBe("generation");
    expect(attrs["sp.prompt.name"]).toBe("weather-chat");
    expect(attrs["sp.prompt.version"]).toBe(3);
    expect(attrs["sp.metadata.route"]).toBe("weather");
  });

  it("maps tool spans and skips fallback prompts", () => {
    const attrs = createSoftprobeObservationAttributes({
      spanType: "tool.call",
      runtimeContext: {
        softprobePrompt: {
          name: "ignored",
          version: 1,
          isFallback: true,
        },
        toolName: "lookup",
        toolCallId: "call_lookup_1",
      },
    });
    expect(attrs["sp.observation.type"]).toBe("tool");
    expect(attrs["sp.prompt.name"]).toBeUndefined();
    expect(attrs["gen_ai.tool.name"]).toBe("lookup");
    expect(attrs["gen_ai.tool.call.id"]).toBe("call_lookup_1");
    expect(attrs["sp.tool.kind"]).toBe("function");
  });

  it("maps operation spans to agent and populates session and user identity attributes", () => {
    const attrs = createSoftprobeObservationAttributes({
      spanType: "operation",
      operationId: "ai.generateText",
      runtimeContext: {
        sessionId: "ses_travel_01",
        userId: "usr_ada",
      },
    });
    expect(attrs["sp.observation.type"]).toBe("agent");
    expect(attrs["session.id"]).toBe("ses_travel_01");
    expect(attrs["sp.session.id"]).toBe("ses_travel_01");
    expect(attrs["gen_ai.conversation.id"]).toBe("ses_travel_01");
    expect(attrs["user.id"]).toBe("usr_ada");
    expect(attrs["sp.user.id"]).toBe("usr_ada");
  });

  it("automatically propagates incoming HTTP traceparent and sessionId without runtimeContext", async () => {
    const client = new SoftprobeClient({ apiKey: "spk_test_auto" });
    installIncomingHttpContextPropagation();

    let capturedAttrs: Record<string, unknown> = {};
    let capturedTraceId: string | undefined;
    let capturedSpanId: string | undefined;

    const server = http.createServer(async (_req, res) => {
      await Promise.resolve();
      const spanCtx = otelTrace.getSpanContext(otelContext.active());
      capturedTraceId = spanCtx?.traceId;
      capturedSpanId = spanCtx?.spanId;
      capturedAttrs = createSoftprobeObservationAttributes({
        spanType: "operation",
        operationId: "ai.generateText",
      });
      res.writeHead(200);
      res.end("ok");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await fetch(
        `http://127.0.0.1:${port}/agent/api/sessions/ses_auto_99/messages`,
        {
          method: "POST",
          headers: {
            traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          },
        },
      );
      expect(res.status).toBe(200);
      expect(capturedTraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(capturedSpanId).toBe("00f067aa0ba902b7");
      expect(capturedAttrs["sp.observation.type"]).toBe("agent");
      expect(capturedAttrs["session.id"]).toBe("ses_auto_99");
      expect(capturedAttrs["sp.session.id"]).toBe("ses_auto_99");
      expect(capturedAttrs["gen_ai.conversation.id"]).toBe("ses_auto_99");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.shutdown();
    }
  });

  it("omits gen_ai.conversation.id and session.id when no session exists and resolves explicit, metadata, and baggage sessions", async () => {
    const standaloneAttrs = createSoftprobeObservationAttributes({
      spanType: "operation",
      operationId: "ai.generateText",
    });
    expect(standaloneAttrs["sp.observation.type"]).toBe("agent");
    expect(standaloneAttrs["session.id"]).toBeUndefined();
    expect(standaloneAttrs["sp.session.id"]).toBeUndefined();
    expect(standaloneAttrs["gen_ai.conversation.id"]).toBeUndefined();

    const metadataAttrs = createSoftprobeObservationAttributes({
      spanType: "operation",
      operationId: "ai.generateText",
      runtimeContext: {
        "ai.telemetry.metadata.conversationId": "conv_meta_42",
      },
    });
    expect(metadataAttrs["session.id"]).toBe("conv_meta_42");
    expect(metadataAttrs["sp.session.id"]).toBe("conv_meta_42");
    expect(metadataAttrs["gen_ai.conversation.id"]).toBe("conv_meta_42");

    const baggageCtx = otelPropagation.setBaggage(
      otelContext.active(),
      otelPropagation.createBaggage({
        "session.id": { value: "ses_baggage_07" },
      }),
    );
    otelContext.with(baggageCtx, () => {
      const baggageAttrs = createSoftprobeObservationAttributes({
        spanType: "operation",
        operationId: "ai.generateText",
      });
      expect(baggageAttrs["session.id"]).toBe("ses_baggage_07");
      expect(baggageAttrs["sp.session.id"]).toBe("ses_baggage_07");
      expect(baggageAttrs["gen_ai.conversation.id"]).toBe("ses_baggage_07");
    });

    const exporter = new InMemorySpanExporter();
    const telemetry = initVercelAiTelemetry({
      apiKey: "spk_test_semconv",
      serviceName: "travel-concierge-agent",
      spanExporter: exporter,
      useSimpleProcessor: true,
    });
    try {
      const aiTracer = otelTrace.getTracer("ai");
      aiTracer.startActiveSpan(
        "ai.generateText",
        { attributes: { "ai.operationId": "ai.generateText" } },
        (span) => {
          span.end();
        },
      );

      withAttributes({ sessionId: "ses_propagated_11" }, () => {
        aiTracer.startActiveSpan(
          "ai.generateText",
          { attributes: { "ai.operationId": "ai.generateText" } },
          (span) => {
            span.end();
          },
        );
      });

      aiTracer.startActiveSpan(
        "ai.generateText",
        {
          attributes: {
            "ai.operationId": "ai.generateText",
            "ai.telemetry.metadata.sessionId": "ses_meta_22",
          },
        },
        (span) => {
          span.end();
        },
      );

      await telemetry.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(3);
      for (const span of spans) {
        expect(span.resource.attributes["service.name"]).toBe(
          "travel-concierge-agent",
        );
        expect(span.attributes["sp.observation.type"]).toBe("agent");
      }

      expect(spans[0]?.attributes["gen_ai.conversation.id"]).toBeUndefined();
      expect(spans[0]?.attributes["session.id"]).toBeUndefined();
      expect(spans[0]?.attributes["sp.session.id"]).toBeUndefined();

      expect(spans[1]?.attributes["gen_ai.conversation.id"]).toBe(
        "ses_propagated_11",
      );
      expect(spans[1]?.attributes["session.id"]).toBe("ses_propagated_11");
      expect(spans[1]?.attributes["sp.session.id"]).toBe("ses_propagated_11");

      expect(spans[2]?.attributes["gen_ai.conversation.id"]).toBe("ses_meta_22");
      expect(spans[2]?.attributes["session.id"]).toBe("ses_meta_22");
      expect(spans[2]?.attributes["sp.session.id"]).toBe("ses_meta_22");

      const integration = new SoftprobeVercelAiSdkIntegration({
        tracer: telemetry.tracer,
      });
      expect(() =>
        integration.onStart({ callId: "call_standalone" }),
      ).not.toThrow();
    } finally {
      await telemetry.shutdown();
    }
  });

  it("propagates W3C traceparent to outgoing fetch and http.request calls across async 202 background turns and direct routes while excluding OTLP collector uploads", async () => {
    const receivedJavaHeaders: Array<{ path: string; traceparent?: string }> = [];
    const receivedCollectorHeaders: Array<{ path: string; traceparent?: string }> = [];

    const javaServer = http.createServer((req, res) => {
      receivedJavaHeaders.push({
        path: req.url ?? "",
        traceparent:
          typeof req.headers.traceparent === "string"
            ? req.headers.traceparent
            : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const collectorServer = http.createServer((req, res) => {
      receivedCollectorHeaders.push({
        path: req.url ?? "",
        traceparent:
          typeof req.headers.traceparent === "string"
            ? req.headers.traceparent
            : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    await Promise.all([
      new Promise<void>((resolve) => javaServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) =>
        collectorServer.listen(0, "127.0.0.1", resolve),
      ),
    ]);

    const javaAddr = javaServer.address();
    const javaPort = typeof javaAddr === "object" && javaAddr ? javaAddr.port : 0;
    const collectorAddr = collectorServer.address();
    const collectorPort =
      typeof collectorAddr === "object" && collectorAddr ? collectorAddr.port : 0;

    const client = new SoftprobeClient({
      apiKey: "spk_test_e2e",
      baseUrl: `http://127.0.0.1:${collectorPort}/api/thelake`,
      useSimpleProcessor: true,
    });
    installIncomingHttpContextPropagation();

    let toolSpanId = "";
    let backgroundDoneResolve!: () => void;
    const backgroundDone = new Promise<void>((resolve) => {
      backgroundDoneResolve = resolve;
    });

    const nodeGateway = http.createServer(async (req, res) => {
      if (req.url?.endsWith("/messages")) {
        // demo-ota server.mjs queues the AI turn on a timer after returning 202 Accepted.
        setTimeout(() => {
          void client.tracer.startActiveSpan(
            "execute_tool travel_search",
            async (toolSpan) => {
              toolSpanId = toolSpan.spanContext().spanId;
              await fetch(`http://127.0.0.1:${javaPort}/api/flights/search`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fromCity: "LHR", toCity: "CDG" }),
              });
              await new Promise<void>((resolve, reject) => {
                const out = http.request(
                  `http://127.0.0.1:${javaPort}/api/flights/orders/query`,
                  { method: "POST" },
                  (resp) => {
                    resp.resume();
                    resp.on("end", () => resolve());
                  },
                );
                out.on("error", reject);
                out.end("{}");
              });
              await fetch(
                `http://127.0.0.1:${collectorPort}/api/thelake/v1/traces`,
                { method: "POST", body: "{}" },
              );
              toolSpan.end();
              backgroundDoneResolve();
            },
          );
        }, 25);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }

      if (req.url?.endsWith("/pay")) {
        await fetch(`http://127.0.0.1:${javaPort}/api/flights/payandissue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId: "BK1" }),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paid: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) =>
      nodeGateway.listen(0, "127.0.0.1", resolve),
    );

    try {
      const gwAddr = nodeGateway.address();
      const gwPort = typeof gwAddr === "object" && gwAddr ? gwAddr.port : 0;

      const msgRes = await fetch(
        `http://127.0.0.1:${gwPort}/agent/api/sessions/ses_live_1/messages`,
        {
          method: "POST",
          headers: {
            traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          },
        },
      );
      expect(msgRes.status).toBe(202);
      await backgroundDone;
      await client.forceFlush();

      const payRes = await fetch(
        `http://127.0.0.1:${gwPort}/agent/api/sessions/ses_live_1/pay`,
        {
          method: "POST",
          headers: {
            traceparent:
              "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
          },
        },
      );
      expect(payRes.status).toBe(200);

      expect(receivedJavaHeaders).toEqual([
        {
          path: "/api/flights/search",
          traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4736-${toolSpanId}-01`,
        },
        {
          path: "/api/flights/orders/query",
          traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4736-${toolSpanId}-01`,
        },
        {
          path: "/api/flights/payandissue",
          traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        },
      ]);

      expect(receivedCollectorHeaders.length).toBeGreaterThanOrEqual(2);
      for (const item of receivedCollectorHeaders) {
        expect(item.traceparent).toBeUndefined();
      }
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => nodeGateway.close(() => resolve())),
        new Promise<void>((resolve) => javaServer.close(() => resolve())),
        new Promise<void>((resolve) => collectorServer.close(() => resolve())),
      ]);
      await client.shutdown();
    }
  });
});
