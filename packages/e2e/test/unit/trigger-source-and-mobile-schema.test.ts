import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTraceScope } from "../../src/fixtures.js";
import {
  isTraceAssertionError,
  isTraceInstrumentationError,
  TraceAssertionError,
  TraceInstrumentationError,
} from "../../src/index.js";
import { BlackboxSink } from "../../src/internal/blackbox-sink.js";
import type { VerifiedTraceEvent } from "../../src/internal/poller.js";
import {
  createBlackboxSessionTriggerSource,
  extractSessionTriggersFromPayload,
} from "../../src/internal/trigger-source.js";
import {
  compileSessionToE2E,
  compileSessionToPlaywright,
  extractSessionBundleFromSpans,
  UI_ACTION_SCHEMA_VERSION,
  type RecordedSemanticAction,
} from "../../src/session-compiler.js";

function listenLocal(server: Server): Promise<{ readonly origin: string }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("Expected numeric TCP address"));
        return;
      }
      const info: AddressInfo = addr;
      resolve({ origin: `http://127.0.0.1:${info.port}` });
    });
  });
}

function closeLocal(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Blackbox session TriggerSource and createTraceScope", () => {
  const activeServers: Server[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      await closeLocal(srv);
    }
  });

  it(
    "polls delayed (> 2s) session spans past the 1.5s ledger cap, falls back past Explorer HTML routes, and verifies outboundHttp payloads",
    async () => {
      const sessionId = "sess_mobile_delayed_01";
      const checkoutTraceId = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
      const sessionSpans: Array<Record<string, unknown>> = [];
      const tracesById = new Map<string, unknown>();

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.headers.authorization !== "Bearer tok_mobile_test") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        if (req.headers["x-workspace-id"] !== "ws_mobile_01") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "missing workspace header" }));
          return;
        }

        if (req.method === "GET" && url.pathname === `/v1/llm/sessions/${sessionId}`) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!doctype html><html><body>Explorer SPA</body></html>");
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === `/api/thelake/v1/llm/sessions/${sessionId}`
        ) {
          if (sessionSpans.length === 0) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "session_not_found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ session_id: sessionId, spans: sessionSpans }));
          return;
        }

        const traceMatch = /^\/api\/thelake\/api\/traces\/([0-9a-f]{32})$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && traceMatch) {
          const payload = tracesById.get(traceMatch[1]!);
          if (!payload) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "trace_not_found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });
      activeServers.push(server);
      const { origin } = await listenLocal(server);

      const sink = new BlackboxSink({
        endpoint: origin,
        token: "tok_mobile_test",
        workspaceId: "ws_mobile_01",
        explorerUrl: origin,
      });
      const triggerSource = createBlackboxSessionTriggerSource({
        endpoint: origin,
        sessionId,
        token: "tok_mobile_test",
        workspaceId: "ws_mobile_01",
      });
      const verifiedEvents: VerifiedTraceEvent[] = [];
      const abortController = new AbortController();
      const trace = createTraceScope({
        triggerSource,
        resolveSink: () => sink,
        pollingDefaults: {
          pollTimeoutMs: 6_000,
          pollIntervalMs: 80,
          settleMs: 30,
        },
        signal: abortController.signal,
        onVerifiedTrace: (ev) => verifiedEvents.push(ev),
      });

      const arrivalTimer = setTimeout(() => {
        const nowMs = Date.now();
        sessionSpans.push({
          trace_id: checkoutTraceId,
          span_id: "1111222233334444",
          session_id: sessionId,
          name: "POST",
          kind: "CLIENT",
          start_time: new Date(nowMs).toISOString(),
          attributes: {
            "http.request.method": "POST",
            "url.full": "http://10.0.2.2:8080/api/mobile/checkout",
            "http.response.status_code": 200,
          },
        });
        tracesById.set(checkoutTraceId, {
          spans: [
            {
              trace_id: checkoutTraceId,
              span_id: "5555666677778888",
              parent_span_id: "1111222233334444",
              name: "POST /api/mobile/checkout",
              kind: "SERVER",
              service_name: "mobile-bff",
              start_time: new Date(nowMs + 5).toISOString(),
              end_time: new Date(nowMs + 45).toISOString(),
              attributes: {
                "http.request.method": "POST",
                "http.route": "/api/mobile/checkout",
                "url.path": "/api/mobile/checkout",
                "http.response.status_code": 200,
              },
            },
            {
              trace_id: checkoutTraceId,
              span_id: "9999aaaabbbbcccc",
              parent_span_id: "5555666677778888",
              name: "POST",
              kind: "CLIENT",
              service_name: "mobile-bff",
              start_time: new Date(nowMs + 10).toISOString(),
              end_time: new Date(nowMs + 40).toISOString(),
              attributes: {
                "http.request.method": "POST",
                "url.full": "https://payments.internal/v1/charges",
                "http.response.status_code": 201,
                "http.request.body.content": JSON.stringify({
                  amountCents: 4200,
                  currency: "USD",
                  platform: "android",
                }),
                "http.response.body.content": JSON.stringify({
                  chargeId: "ch_mobile_99",
                  captured: true,
                }),
              },
            },
          ],
        });
      }, 2_100);

      try {
        const call = await trace.outboundHttp({
          triggeredBy: { method: "POST", path: "/api/mobile/checkout" },
          method: "POST",
          url: /\/v1\/charges$/,
          status: 201,
        });

        expect(call.traceId).toBe(checkoutTraceId);
        expect(call.serviceName).toBe("mobile-bff");
        expect(call.request.json).toEqual({
          amountCents: 4200,
          currency: "USD",
          platform: "android",
        });
        expect(call.response.json).toEqual({
          chargeId: "ch_mobile_99",
          captured: true,
        });
        expect(verifiedEvents).toHaveLength(1);
        expect(verifiedEvents[0]?.trigger.headerSource).toBe("preserved");
      } finally {
        clearTimeout(arrivalTimer);
        abortController.abort();
      }
    },
    10_000,
  );

  it("isolates repeated calls to the same route via trace.window timestamp bounds and enforces expectNoOutboundHttp and TraceInstrumentationError", async () => {
    const sessionId = "sess_mobile_window_02";
    const beforeTraceId = "11111111111111111111111111111111";
    const windowTraceId = "22222222222222222222222222222222";
    const afterTraceId = "33333333333333333333333333333333";
    const noopTraceId = "44444444444444444444444444444444";
    const uninstrumentedTraceId = "55555555555555555555555555555555";

    const sessionSpans: Array<Record<string, unknown>> = [];
    const tracesById = new Map<string, unknown>();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === `/v1/llm/sessions/${sessionId}`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: sessionId, spans: sessionSpans }));
        return;
      }
      const traceMatch = /^\/api\/traces\/([0-9a-f]{32})$/.exec(url.pathname);
      if (req.method === "GET" && traceMatch) {
        const payload = tracesById.get(traceMatch[1]!);
        if (!payload) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    activeServers.push(server);
    const { origin } = await listenLocal(server);

    const registerOrderAttempt = (
      traceId: string,
      startedAtMs: number,
      attemptTag: string,
      flushImmediately: boolean,
    ) => {
      const clientSpan = {
        trace_id: traceId,
        span_id: `${traceId.slice(0, 8)}00000001`,
        session_id: sessionId,
        name: "POST",
        kind: "CLIENT",
        startTimeUnixNano: String(BigInt(startedAtMs) * 1_000_000n),
        attributes: {
          "http.request.method": "POST",
          "url.full": `http://10.0.2.2:8080/api/orders/${attemptTag}`,
        },
      };
      const serverSpan = {
        trace_id: traceId,
        span_id: `${traceId.slice(0, 8)}00000002`,
        parent_span_id: `${traceId.slice(0, 8)}00000001`,
        session_id: sessionId,
        name: "POST /api/orders/:id",
        kind: "SERVER",
        service_name: "orders-bff",
        startTimeUnixNano: String(BigInt(startedAtMs + 2) * 1_000_000n),
        endTimeUnixNano: String(BigInt(startedAtMs + 20) * 1_000_000n),
        attributes: {
          "http.request.method": "POST",
          "http.route": "/api/orders/:id",
          "url.path": `/api/orders/${attemptTag}`,
          "http.response.status_code": 200,
        },
      };
      const controllerInternalSpan = {
        trace_id: traceId,
        span_id: `${traceId.slice(0, 8)}0000000a`,
        parent_span_id: `${traceId.slice(0, 8)}00000002`,
        session_id: sessionId,
        name: "OrderService.create",
        kind: "INTERNAL",
        service_name: "orders-bff",
        startTimeUnixNano: String(BigInt(startedAtMs + 3) * 1_000_000n),
        endTimeUnixNano: String(BigInt(startedAtMs + 19) * 1_000_000n),
        attributes: {},
      };
      const downstreamSpan = {
        trace_id: traceId,
        span_id: `${traceId.slice(0, 8)}00000003`,
        parent_span_id: `${traceId.slice(0, 8)}0000000a`,
        session_id: sessionId,
        name: "POST",
        kind: "CLIENT",
        service_name: "orders-bff",
        startTimeUnixNano: String(BigInt(startedAtMs + 5) * 1_000_000n),
        endTimeUnixNano: String(BigInt(startedAtMs + 18) * 1_000_000n),
        attributes: {
          "http.request.method": "POST",
          "url.full": "https://fulfillment.internal/v1/dispatch",
          "http.response.status_code": 200,
          "http.request.body.content": JSON.stringify({ attempt: attemptTag }),
        },
      };
      tracesById.set(traceId, {
        spans: [serverSpan, controllerInternalSpan, downstreamSpan],
      });
      if (flushImmediately) {
        sessionSpans.push(
          clientSpan,
          serverSpan,
          controllerInternalSpan,
          downstreamSpan,
        );
      }
      return [clientSpan, serverSpan, controllerInternalSpan, downstreamSpan];
    };

    const sink = new BlackboxSink({
      endpoint: origin,
      explorerUrl: `${origin}/explorer`,
    });
    const triggerSource = createBlackboxSessionTriggerSource({
      endpoint: origin,
      sessionId,
    });
    const abortController = new AbortController();
    const trace = createTraceScope({
      triggerSource,
      resolveSink: () => sink,
      pollingDefaults: {
        pollTimeoutMs: 1_500,
        pollIntervalMs: 30,
        settleMs: 25,
      },
      signal: abortController.signal,
    });

    try {
      registerOrderAttempt(beforeTraceId, Date.now() - 200, "first", true);
      await waitMs(15);

      let deferredWindowSpans: Array<Record<string, unknown>> = [];
      const windowedScope = await trace.window(async () => {
        await waitMs(10);
        deferredWindowSpans = registerOrderAttempt(
          windowTraceId,
          Date.now(),
          "second",
          false,
        );
        await waitMs(10);
      });

      await waitMs(15);
      registerOrderAttempt(afterTraceId, Date.now(), "third", true);

      setTimeout(() => {
        sessionSpans.push(...deferredWindowSpans);
      }, 60);

      const windowedCall = await windowedScope.outboundHttp({
        triggeredBy: { method: "POST", path: "/api/orders/:id" },
        url: /\/v1\/dispatch$/,
      });
      expect(windowedCall.traceId).toBe(windowTraceId);
      expect(windowedCall.request.json).toEqual({ attempt: "second" });

      const latestCall = await trace.outboundHttp({
        triggeredBy: { method: "POST", path: "/api/orders/:id" },
        url: /\/v1\/dispatch$/,
      });
      expect(latestCall.traceId).toBe(afterTraceId);
      expect(latestCall.request.json).toEqual({ attempt: "third" });

      await expect(
        trace.expectNoOutboundHttp({
          triggeredBy: { method: "POST", path: "/api/orders/:id" },
          url: /\/v1\/dispatch$/,
        }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isTraceAssertionError(err) &&
          err instanceof TraceAssertionError &&
          err.traceId === afterTraceId &&
          err.observedCalls.length === 1,
      );

      const noopTimeMs = Date.now();
      const noopServerSpan = {
        trace_id: noopTraceId,
        span_id: "4444444400000002",
        session_id: sessionId,
        name: "POST /api/validate",
        kind: "SERVER",
        service_name: "orders-bff",
        startTimeUnixNano: String(BigInt(noopTimeMs) * 1_000_000n),
        endTimeUnixNano: String(BigInt(noopTimeMs + 8) * 1_000_000n),
        attributes: {
          "http.request.method": "POST",
          "url.path": "/api/validate",
          "http.response.status_code": 409,
        },
      };
      sessionSpans.push(noopServerSpan);
      tracesById.set(noopTraceId, { spans: [noopServerSpan] });

      await expect(
        trace.expectNoOutboundHttp({
          triggeredBy: { method: "POST", path: "/api/validate" },
        }),
      ).resolves.toBeUndefined();

      const uninstrumentedMs = Date.now();
      sessionSpans.push({
        trace_id: uninstrumentedTraceId,
        span_id: "5555555500000001",
        session_id: sessionId,
        name: "POST",
        kind: "CLIENT",
        startTimeUnixNano: String(BigInt(uninstrumentedMs) * 1_000_000n),
        attributes: {
          "http.request.method": "POST",
          "url.full": "http://10.0.2.2:8080/api/uninstrumented",
        },
      });

      await expect(
        trace.outboundHttp({
          triggeredBy: { method: "POST", path: "/api/uninstrumented" },
          url: /\/v1\/dispatch$/,
          pollTimeoutMs: 160,
          pollIntervalMs: 30,
        }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isTraceInstrumentationError(err) &&
          err instanceof TraceInstrumentationError &&
          err.traceId === uninstrumentedTraceId &&
          err.explorerTraceUrl === `${origin}/explorer/?trace=${uninstrumentedTraceId}`,
      );

      await expect(
        trace.expectNoOutboundHttp({
          triggeredBy: { method: "POST", path: "/api/uninstrumented" },
          pollTimeoutMs: 160,
          pollIntervalMs: 30,
        }),
      ).rejects.toSatisfy((err: unknown) => isTraceInstrumentationError(err));

      const extractedTriggers = extractSessionTriggersFromPayload({
        spans: sessionSpans,
      });
      expect(
        extractedTriggers.some((entry) => entry.pathname === "/v1/dispatch"),
      ).toBe(false);
    } finally {
      abortController.abort();
    }
  });
});

describe("Mobile sp-ui-action-1 contract in session-compiler", () => {
  it("parses, summarizes, correlates, and compiles all 5 mobile SemanticVerb variants plus platform and captureSource metadata", () => {
    expect(UI_ACTION_SCHEMA_VERSION).toBe("sp-ui-action-1");

    const holdFareTraceId = "abcdef0123456789abcdef0123456789";
    const mobileActions: RecordedSemanticAction[] = [
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 0,
        timestampMs: 1700000100000,
        startPath: "/flights",
        endPath: "/flights",
        viewport: { width: 393, height: 852 },
        platform: "ios",
        captureSource: "host_agent",
        verb: {
          name: "swipe",
          direction: "up",
          target: {
            role: "list",
            name: "Flight results",
            accessibilityId: "flight-results-list",
            interactive: true,
          },
          distanceRatio: 0.65,
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 120,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 1,
        timestampMs: 1700000101000,
        startPath: "/flights",
        endPath: "/flights",
        viewport: { width: 393, height: 852 },
        platform: "ios",
        captureSource: "otel_sdk",
        verb: {
          name: "dismissKeyboard",
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 30,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 2,
        timestampMs: 1700000102000,
        startPath: "/flights",
        endPath: "/flights/hold",
        viewport: { width: 393, height: 852 },
        platform: "android",
        captureSource: "otel_sdk",
        verb: {
          name: "longPress",
          target: {
            accessibilityId: "hold-fare-btn",
            role: "button",
            nearbyLabel: "Nonstop SFO to NRT",
            interactive: true,
          },
          point: { x: 196, y: 640 },
          durationMs: 750,
        },
        causedTraces: [],
        endAnchors: [
          {
            accessibilityId: "hold-confirmed-banner",
            role: "status",
            name: "Fare held for 24h",
          },
        ],
        goneAnchors: [],
        settleMs: 180,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 3,
        timestampMs: 1700000104000,
        startPath: "/flights/hold",
        endPath: "/flights",
        viewport: { width: 393, height: 852 },
        platform: "android",
        captureSource: "host_agent",
        verb: {
          name: "back",
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 80,
      },
      {
        schemaVersion: "sp-ui-action-1",
        actionIndex: 4,
        timestampMs: 1700000105000,
        startPath: "/flights",
        endPath: "/booking/42",
        viewport: { width: 393, height: 852 },
        platform: "ios",
        captureSource: "otel_sdk",
        verb: {
          name: "openLink",
          url: "softprobe://booking/42",
        },
        causedTraces: [],
        endAnchors: [],
        goneAnchors: [],
        settleMs: 95,
      },
    ];

    const spans = [
      ...mobileActions.map((act, index) => ({
        trace_id: `0000000000000000000000000000001${index}`,
        span_id: `000000000000001${index}`,
        session_id: "sess_mobile_verbs",
        name: "softprobe.ui.action",
        service_name: "mobile-travel-app",
        start_time: new Date(act.timestampMs).toISOString(),
        attributes: {
          "sp.observation.type": "ui_action",
          "sp.ui.action.schema": "sp-ui-action-1",
          "sp.ui.action.index": act.actionIndex,
          "sp.ui.action.verb": act.verb.name,
          "sp.ui.action.payload": `sp.json:${JSON.stringify(act)}`,
        },
      })),
      {
        trace_id: holdFareTraceId,
        span_id: "1234567812345678",
        session_id: "sess_mobile_verbs",
        name: "POST",
        service_name: "mobile-travel-app",
        start_time: new Date(1700000102030).toISOString(),
        attributes: {
          "http.request.method": "POST",
          "url.full": "http://10.0.2.2:8080/api/holds",
          "http.response.status_code": 200,
        },
      },
      {
        trace_id: holdFareTraceId,
        span_id: "8765432187654321",
        parent_span_id: "1234567812345678",
        session_id: "sess_mobile_verbs",
        name: "POST /api/holds",
        kind: "SERVER",
        service_name: "ota-backend",
        start_time: new Date(1700000102035).toISOString(),
        end_time: new Date(1700000102090).toISOString(),
        attributes: {
          "http.request.method": "POST",
          "url.path": "/api/holds",
          "http.response.status_code": 200,
        },
      },
      {
        trace_id: holdFareTraceId,
        span_id: "fedcba9876543210",
        parent_span_id: "8765432187654321",
        session_id: "sess_mobile_verbs",
        name: "POST",
        kind: "CLIENT",
        service_name: "ota-backend",
        start_time: new Date(1700000102045).toISOString(),
        end_time: new Date(1700000102080).toISOString(),
        attributes: {
          "http.request.method": "POST",
          "url.full": "https://gds.internal/v1/pnr/hold",
          "http.response.status_code": 201,
        },
      },
    ];

    const bundle = extractSessionBundleFromSpans({
      session_id: "sess_mobile_verbs",
      spans,
    });

    expect(bundle.steps).toHaveLength(5);
    expect(bundle.steps.map((s) => s.summary)).toEqual([
      'swipe up on list "Flight results"',
      "dismiss keyboard",
      'long-press button "Nonstop SFO to NRT"',
      "navigate back",
      "open link softprobe://booking/42",
    ]);
    expect(bundle.steps[0]?.action.platform).toBe("ios");
    expect(bundle.steps[0]?.action.captureSource).toBe("host_agent");
    expect(bundle.steps[2]?.action.platform).toBe("android");
    expect(bundle.steps[2]?.action.captureSource).toBe("otel_sdk");
    expect(bundle.steps[2]?.backendTraces).toHaveLength(1);
    expect(bundle.outboundAssertionCount).toBe(1);

    const pwSuite = compileSessionToPlaywright(bundle, { includeConfig: false });
    const pwSpec = pwSuite.files[0]?.content ?? "";
    expect(pwSpec).toContain(`await page.mouse.wheel(0, 260);`);
    expect(pwSpec).toContain(`await page.keyboard.press("Escape");`);
    expect(pwSpec).toContain(`await page.getByTestId("hold-fare-btn").click({ delay: 750 });`);
    expect(pwSpec).toContain(`await page.goBack();`);
    expect(pwSpec).toContain(`await page.goto("softprobe://booking/42");`);

    const e2eSuite = compileSessionToE2E(bundle, { includeConfig: false });
    expect(e2eSuite.cacheFiles.length).toBe(3);
    const cacheActionsSchema = z.object({
      payload: z.object({
        actions: z.array(
          z.object({
            name: z.string(),
            target: z.object({ testId: z.string().optional() }).optional(),
            spans: z.number().optional(),
            url: z.string().optional(),
          }),
        ),
      }),
    });

    const firstGroup = cacheActionsSchema.parse(
      JSON.parse(e2eSuite.cacheFiles[0]!.content),
    );
    expect(firstGroup.payload.actions.map((a) => a.name)).toEqual([
      "scroll",
      "dismissKeyboard",
      "longPress",
    ]);
    expect(firstGroup.payload.actions[0]?.spans).toBe(0.65);
    expect(firstGroup.payload.actions[2]?.target?.testId).toBe("hold-fare-btn");

    const secondGroup = cacheActionsSchema.parse(
      JSON.parse(e2eSuite.cacheFiles[1]!.content),
    );
    expect(secondGroup.payload.actions[0]?.name).toBe("back");

    const thirdGroup = cacheActionsSchema.parse(
      JSON.parse(e2eSuite.cacheFiles[2]!.content),
    );
    expect(thirdGroup.payload.actions[0]).toMatchObject({
      name: "navigate",
      url: "softprobe://booking/42",
    });
  });
});
