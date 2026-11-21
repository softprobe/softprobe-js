import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentError as upstreamAgentError,
  credentials as upstreamCredentials,
  expect as upstreamExpect,
  isAgentError as upstreamIsAgentError,
  secrets as upstreamSecrets,
  unique as upstreamUnique,
} from "e2e";
import { describe, expect, it } from "vitest";
import {
  AgentError,
  credentials,
  expect as sdkExpect,
  isAgentError,
  isSpanId,
  isTraceAssertionError,
  isTraceId,
  isTraceInstrumentationError,
  secrets,
  softprobeWeb,
  TraceAssertionError,
  TraceInstrumentationError,
  unique,
} from "../../src/index.js";
import { ArexSink, parseArexTracePayload } from "../../src/internal/arex-sink.js";
import {
  BlackboxSink,
  parseBlackboxTracePayload,
} from "../../src/internal/blackbox-sink.js";
import {
  getEngineMetadata,
  resolveSinkConfig,
  splitSoftprobeWebOptions,
} from "../../src/internal/config.js";
import {
  BrowserAttemptLedger,
  buildApiRoutePatterns,
  compileTriggerPathMatcher,
  parseW3cTraceparent,
  selectLatestMatchingTrigger,
} from "../../src/internal/correlator.js";
import {
  pollExpectNoOutboundHttp,
  pollOutboundHttp,
} from "../../src/internal/poller.js";
import { stageVerifiedTraceRecord } from "../../src/internal/reporter.js";
import type { TracePollSnapshot, TraceSink } from "../../src/internal/sink-shared.js";

const VALID_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const VALID_SPAN_ID = "00f067aa0ba902b7";

describe("@softprobe/e2e public contract and branded types", () => {
  it("re-exports upstream e2e primitives unmodified without shadowing expect", () => {
    expect(sdkExpect).toBe(upstreamExpect);
    expect("extend" in sdkExpect).toBe(false);
    expect(credentials).toBe(upstreamCredentials);
    expect(secrets).toBe(upstreamSecrets);
    expect(unique).toBe(upstreamUnique);
    expect(AgentError).toBe(upstreamAgentError);
    expect(isAgentError).toBe(upstreamIsAgentError);
  });

  it("exposes root, playwright, session-compiler, and compile-session CLI subpaths in package.json exports", () => {
    const pkgDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const rawPkg: unknown = JSON.parse(
      readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    );
    expect(typeof rawPkg === "object" && rawPkg !== null && "exports" in rawPkg).toBe(
      true,
    );
    if (
      typeof rawPkg === "object" &&
      rawPkg !== null &&
      "exports" in rawPkg &&
      typeof rawPkg.exports === "object" &&
      rawPkg.exports !== null
    ) {
      expect(Object.keys(rawPkg.exports)).toEqual([
        ".",
        "./playwright",
        "./session-compiler",
        "./bin/compile-session.js",
      ]);
    }
  });

  it("validates TraceId and SpanId brands strictly", () => {
    expect(isTraceId(VALID_TRACE_ID)).toBe(true);
    expect(isTraceId("0".repeat(32))).toBe(false);
    expect(isTraceId(VALID_TRACE_ID.toUpperCase())).toBe(false);
    expect(isTraceId("4bf92f3577b34da6")).toBe(false);
    expect(isTraceId(123)).toBe(false);

    expect(isSpanId(VALID_SPAN_ID)).toBe(true);
    expect(isSpanId("0".repeat(16))).toBe(false);
    expect(isSpanId(VALID_SPAN_ID.toUpperCase())).toBe(false);
    expect(isSpanId("00f067aa")).toBe(false);
    expect(isSpanId(null)).toBe(false);
  });

  it("attaches Softprobe metadata to softprobeWeb engine handles and resolves sink configs", () => {
    const engine = softprobeWeb({
      endpoint: "https://explorer-staging.softprobe.ai",
      workspaceId: "a0528065-36ad-4650-a184-1e745c7c695d",
      pollTimeoutMs: 8_000,
      pollIntervalMs: 120,
      viewport: { width: 1280, height: 720 },
    });

    expect(engine.name).toBe("web");
    const metadata = getEngineMetadata(engine);
    expect(metadata?.polling.pollTimeoutMs).toBe(8_000);
    expect(metadata?.polling.pollIntervalMs).toBe(120);

    const resolvedBlackbox = resolveSinkConfig(
      {
        endpoint: "https://explorer-staging.softprobe.ai",
        workspaceId: "a0528065-36ad-4650-a184-1e745c7c695d",
      },
      { SOFTPROBE_TOKEN: "tok_test" },
    );
    expect(resolvedBlackbox).toEqual({
      kind: "blackbox",
      endpoint: "https://explorer-staging.softprobe.ai/api/thelake",
      token: "tok_test",
      workspaceId: "a0528065-36ad-4650-a184-1e745c7c695d",
      explorerUrl: "https://explorer-staging.softprobe.ai",
    });

    const resolvedArex = resolveSinkConfig(
      {
        store: "arex",
        appId: "travel-ota",
      },
      {
        SP_API_URL: "http://127.0.0.1:18090/",
        SP_TOKEN: "sp_tok",
        SP_TENANT_ID: "tenant_7",
      },
    );
    expect(resolvedArex).toEqual({
      kind: "arex",
      endpoint: "http://127.0.0.1:18090",
      appId: "travel-ota",
      token: "sp_tok",
      tenantId: "tenant_7",
    });

    expect(() => splitSoftprobeWebOptions({ pollTimeoutMs: 0 })).toThrow();
  });
});

describe("W3C traceparent correlator and trigger ledger", () => {
  it("preserves existing valid traceparent without overwriting headers and mints when absent", async () => {
    const ledger = new BrowserAttemptLedger();
    const continueCalls: Array<unknown> = [];

    const existingHeader = `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`;
    await ledger.handleRoute({
      request: {
        method: "POST",
        url: "http://127.0.0.1:3000/api/workspaces/ws_1/invites?source=ui",
        headers: {
          "content-type": "application/json",
          traceparent: existingHeader,
        },
      },
      fetch: async () => {
        throw new Error("not used");
      },
      fulfill: async () => undefined,
      continue: async (overrides) => {
        continueCalls.push(overrides);
      },
      fallback: async () => undefined,
      abort: async () => undefined,
    });

    expect(continueCalls).toEqual([undefined]);
    const preserved = ledger.rootView()[0];
    expect(preserved?.traceId).toBe(VALID_TRACE_ID);
    expect(preserved?.headerSource).toBe("preserved");
    expect(preserved?.pathname).toBe("/api/workspaces/ws_1/invites");

    await ledger.handleRoute({
      request: {
        method: "POST",
        url: "http://127.0.0.1:3000/api/workspaces/ws_1/invites",
        headers: {
          "x-custom": "keep-me",
        },
      },
      fetch: async () => {
        throw new Error("not used");
      },
      fulfill: async () => undefined,
      continue: async (overrides) => {
        continueCalls.push(overrides);
      },
      fallback: async () => undefined,
      abort: async () => undefined,
    });

    const secondCall = continueCalls[1];
    expect(
      typeof secondCall === "object" &&
        secondCall !== null &&
        "headers" in secondCall,
    ).toBe(true);
    let mintedHeader: string | undefined;
    if (
      typeof secondCall === "object" &&
      secondCall !== null &&
      "headers" in secondCall &&
      typeof secondCall.headers === "object" &&
      secondCall.headers !== null
    ) {
      const headersRecord = secondCall.headers;
      expect("x-custom" in headersRecord && headersRecord["x-custom"]).toBe("keep-me");
      if (
        "traceparent" in headersRecord &&
        typeof headersRecord.traceparent === "string"
      ) {
        mintedHeader = headersRecord.traceparent;
      }
    }
    const parsedMinted = parseW3cTraceparent(mintedHeader);
    expect(parsedMinted).not.toBeNull();
    expect(ledger.rootView()[1]?.traceId).toBe(parsedMinted?.traceId);
    expect(ledger.rootView()[1]?.headerSource).toBe("minted");
  });

  it("matches :param path segments ignoring query strings and scopes trace.window slices", async () => {
    const matcher = compileTriggerPathMatcher(
      "/api/workspaces/:workspaceId/invites",
    );
    expect(matcher("/api/workspaces/a0528065-36ad-4650-a184-1e745c7c695d/invites")).toBe(true);
    expect(matcher("/api/workspaces/ws_1/invites/")).toBe(true);
    expect(matcher("/api/workspaces/ws_1/invites/inv_2/resend")).toBe(false);
    expect(matcher("/api/workspaces/invites")).toBe(false);

    const ledger = new BrowserAttemptLedger();
    ledger.recordRequest({
      method: "POST",
      url: "http://127.0.0.1:3000/api/workspaces/ws_1/invites?step=1",
      headers: {},
    });

    const windowView = await ledger.captureWindow(async () => {
      ledger.recordRequest({
        method: "POST",
        url: "http://127.0.0.1:3000/api/workspaces/ws_1/invites?step=2",
        headers: {},
      });
      ledger.recordRequest({
        method: "GET",
        url: "http://127.0.0.1:3000/api/workspaces/ws_1/members",
        headers: {},
      });
    });

    ledger.recordRequest({
      method: "POST",
      url: "http://127.0.0.1:3000/api/workspaces/ws_1/invites?step=3",
      headers: {},
    });

    const windowedMatch = selectLatestMatchingTrigger(windowView(), {
      method: "POST",
      path: "/api/workspaces/:workspaceId/invites",
    });
    expect(windowedMatch?.url).toContain("step=2");

    const rootMatch = selectLatestMatchingTrigger(ledger.rootView(), {
      method: "POST",
      path: "/api/workspaces/:workspaceId/invites",
    });
    expect(rootMatch?.url).toContain("step=3");

    const patterns = buildApiRoutePatterns("http://127.0.0.1:3000", [
      "https://api.example.com",
    ]);
    expect(patterns.length).toBe(2);
  });
});

describe("BlackboxSink and ArexSink boundary parsers", () => {
  it("coalesces softprobe.http.body.capture, strips sp.json:, and ignores browser root CLIENT spans", async () => {
    if (!isTraceId(VALID_TRACE_ID)) throw new Error("invalid fixture trace id");

    const tempoPayload = {
      batches: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "explorer-web" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "@softprobe/web-record" },
              spans: [
                {
                  traceId: VALID_TRACE_ID,
                  spanId: "1111111111111111",
                  name: "POST",
                  kind: "SPAN_KIND_CLIENT",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000100000000",
                  attributes: [
                    { key: "http.request.method", value: { stringValue: "POST" } },
                    {
                      key: "url.full",
                      value: { stringValue: "http://127.0.0.1:3000/api/workspaces/ws_1/invites" },
                    },
                    { key: "http.response.status_code", value: { intValue: "200" } },
                  ],
                },
              ],
            },
          ],
        },
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "sp-explorer-worker" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "@opentelemetry/instrumentation-undici" },
              spans: [
                {
                  traceId: VALID_TRACE_ID,
                  spanId: "2222222222222222",
                  parentSpanId: "1111111111111111",
                  name: "POST /api/workspaces/:id/invites",
                  kind: 2,
                  startTimeUnixNano: "1700000000005000000",
                  endTimeUnixNano: "1700000000095000000",
                  attributes: [
                    { key: "http.request.method", value: { stringValue: "POST" } },
                    { key: "url.path", value: { stringValue: "/api/workspaces/ws_1/invites" } },
                    { key: "http.response.status_code", value: { intValue: 200 } },
                  ],
                },
                {
                  traceId: VALID_TRACE_ID,
                  spanId: "3333333333333333",
                  parentSpanId: "2222222222222222",
                  name: "softprobe.http.body.capture",
                  kind: 1,
                  startTimeUnixNano: "1700000000010000000",
                  endTimeUnixNano: "1700000000080000000",
                  attributes: [
                    { key: "sp.observation.type", value: { stringValue: "http_body" } },
                    {
                      key: "http.request.body.content",
                      value: {
                        stringValue:
                          'sp.json:{"subject":"Invite to Workspace","to":[{"address":"lc@softprobe.ai"}],"text":"Accept at /invite/[REDACTED]"}',
                      },
                    },
                    {
                      key: "http.response.body.content",
                      value: { stringValue: 'sp.json:{"messageId":"msg_99"}' },
                    },
                  ],
                },
                {
                  traceId: VALID_TRACE_ID,
                  spanId: "4444444444444444",
                  parentSpanId: "3333333333333333",
                  name: "POST",
                  kind: 3,
                  startTimeUnixNano: "1700000000012000000",
                  endTimeUnixNano: "1700000000078000000",
                  attributes: [
                    { key: "http.request.method", value: { stringValue: "POST" } },
                    {
                      key: "url.full",
                      value: { stringValue: "https://emailengine.internal/v1/account/invite/submit" },
                    },
                    { key: "http.response.status_code", value: { intValue: 202 } },
                    {
                      key: "http.request.header.content_type",
                      value: { stringValue: 'sp.json:["application/json"]' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const snapshot = parseBlackboxTracePayload(
      VALID_TRACE_ID,
      tempoPayload,
      `https://explorer.softprobe.ai/?trace=${VALID_TRACE_ID}`,
    );

    expect(snapshot.state).toBe("ingested");
    if (snapshot.state !== "ingested") return;
    expect(snapshot.serverEntry.spanId).toBe("2222222222222222");
    expect(snapshot.outboundHttp).toHaveLength(1);

    const call = snapshot.outboundHttp[0]!;
    expect(call.spanId).toBe("4444444444444444");
    expect(call.parentServerSpanId).toBe("2222222222222222");
    expect(call.status).toBe(202);
    expect(call.request.headers["content-type"]).toBe("application/json");
    expect(call.request.captureStatus).toBe("captured");
    expect(call.request.json).toEqual({
      subject: "Invite to Workspace",
      to: [{ address: "lc@softprobe.ai" }],
      text: "Accept at /invite/[REDACTED]",
    });
    expect(call.response.json).toEqual({ messageId: "msg_99" });

    const seenHeaders: Headers[] = [];
    const sink = new BlackboxSink({
      endpoint: "https://explorer.softprobe.ai/api/thelake",
      token: "bb_secret",
      workspaceId: "ws_uuid",
      explorerUrl: "https://explorer.softprobe.ai",
      fetchImpl: async (_url, init) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ message: "trace not found" }), {
          status: 404,
        });
      },
    });
    const notFound = await sink.fetchTrace(VALID_TRACE_ID, new AbortController().signal);
    expect(notFound).toEqual({
      traceId: VALID_TRACE_ID,
      state: "awaiting_server_span",
    });
    expect(seenHeaders[0]?.get("authorization")).toBe("Bearer bb_secret");
    expect(seenHeaders[0]?.get("x-workspace-id")).toBe("ws_uuid");
  });

  it("parses wrapped and direct ArexSink payloads and sends appId + auth headers", async () => {
    if (!isTraceId(VALID_TRACE_ID)) throw new Error("invalid fixture trace id");

    const parsed = parseArexTracePayload(
      VALID_TRACE_ID,
      {
        body: {
          traceId: VALID_TRACE_ID,
          state: "ingested",
          serverEntry: {
            spanId: "aaaaaaaa11111111",
            serviceName: "travel-ota",
            method: "POST",
            routeOrPath: "/api/flights/search",
            status: 200,
            durationMs: 42,
          },
          outboundHttp: [
            {
              spanId: "bbbbbbbb22222222",
              method: "POST",
              url: "https://spair.softprobe.ai/ndc/v21.3/airshopping",
              status: 200,
              durationMs: 31,
              request: {
                body: '{"origin":"SFO","destination":"NRT"}',
                headers: { "Content-Type": "application/json" },
              },
              response: {
                json: { offers: [{ id: "off_1" }] },
              },
            },
          ],
        },
      },
      undefined,
    );

    expect(parsed.state).toBe("ingested");
    if (parsed.state !== "ingested") return;
    expect(parsed.outboundHttp[0]?.request.json).toEqual({
      origin: "SFO",
      destination: "NRT",
    });
    expect(parsed.outboundHttp[0]?.response.json).toEqual({
      offers: [{ id: "off_1" }],
    });

    let requestedUrl = "";
    let requestedHeaders = new Headers();
    const arexSink = new ArexSink({
      endpoint: "http://127.0.0.1:18090",
      appId: "travel-ota",
      token: "arex_tok",
      tenantId: "t_1",
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            traceId: VALID_TRACE_ID,
            state: "awaiting_server_span",
          }),
          { status: 200 },
        );
      },
    });

    const awaiting = await arexSink.fetchTrace(
      VALID_TRACE_ID,
      new AbortController().signal,
    );
    expect(awaiting.state).toBe("awaiting_server_span");
    expect(requestedUrl).toBe(
      `http://127.0.0.1:18090/api/traces/${VALID_TRACE_ID}/outbound-http?appId=travel-ota`,
    );
    expect(requestedHeaders.get("authorization")).toBe("Bearer arex_tok");
    expect(requestedHeaders.get("x-tenant-id")).toBe("t_1");
  });
});

describe("Two-phase SERVER-anchor poller", () => {
  it("throws TraceInstrumentationError when awaiting_server_span times out on both outboundHttp and expectNoOutboundHttp", async () => {
    if (!isTraceId(VALID_TRACE_ID)) throw new Error("invalid fixture trace id");
    const ledger = new BrowserAttemptLedger();
    ledger.recordRequest({
      method: "POST",
      url: "http://127.0.0.1:3000/api/workspaces/ws_1/invites",
      headers: { traceparent: `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01` },
    });

    const brokenSink: TraceSink = {
      kind: "blackbox",
      sinkUrl: "http://127.0.0.1:8091",
      buildExplorerTraceUrl: (id) => `http://127.0.0.1:5173/?trace=${id}`,
      fetchTrace: async (traceId) => ({
        traceId,
        state: "awaiting_server_span",
      }),
    };

    const defaults = { pollTimeoutMs: 120, pollIntervalMs: 30, settleMs: 20 };

    await expect(
      pollOutboundHttp(
        { ledgerView: ledger.rootView, sink: brokenSink, defaults },
        {
          triggeredBy: { method: "POST", path: "/api/workspaces/:id/invites" },
          url: /emailengine/,
        },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        isTraceInstrumentationError(err) &&
        err instanceof TraceInstrumentationError &&
        err.traceId === VALID_TRACE_ID &&
        err.explorerTraceUrl === `http://127.0.0.1:5173/?trace=${VALID_TRACE_ID}`
      );
    });

    await expect(
      pollExpectNoOutboundHttp(
        { ledgerView: ledger.rootView, sink: brokenSink, defaults },
        {
          triggeredBy: { method: "POST", path: "/api/workspaces/:id/invites" },
          url: /emailengine/,
        },
      ),
    ).rejects.toSatisfy((err: unknown) => isTraceInstrumentationError(err));
  });

  it("transitions from awaiting_server_span to ingested and lists observed calls on TraceAssertionError", async () => {
    const childSpanCandidate = "1234567890abcdef";
    if (!isTraceId(VALID_TRACE_ID) || !isSpanId(VALID_SPAN_ID) || !isSpanId(childSpanCandidate)) {
      throw new Error("invalid fixture ids");
    }
    const ledger = new BrowserAttemptLedger();
    ledger.recordRequest({
      method: "POST",
      url: "http://127.0.0.1:3000/api/workspaces/ws_1/invites",
      headers: { traceparent: `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01` },
    });

    let calls = 0;
    const stagedSnapshots: TracePollSnapshot[] = [
      { traceId: VALID_TRACE_ID, state: "awaiting_server_span" },
      {
        traceId: VALID_TRACE_ID,
        state: "ingested",
        serverEntry: {
          spanId: VALID_SPAN_ID,
          serviceName: "explorer",
          durationMs: 10,
        },
        outboundHttp: [],
      },
      {
        traceId: VALID_TRACE_ID,
        state: "ingested",
        serverEntry: {
          spanId: VALID_SPAN_ID,
          serviceName: "explorer",
          durationMs: 10,
        },
        outboundHttp: [
          {
            traceId: VALID_TRACE_ID,
            spanId: childSpanCandidate,
            parentServerSpanId: VALID_SPAN_ID,
            serviceName: "explorer",
            method: "POST",
            url: "https://api.resend.com/emails",
            status: 200,
            durationMs: 15,
            request: {
              text: '{"to":["lc@softprobe.ai"]}',
              json: { to: ["lc@softprobe.ai"] },
              headers: {},
              captureStatus: "captured",
            },
            response: {
              text: null,
              json: undefined,
              headers: {},
              captureStatus: "omitted",
            },
          },
        ],
      },
    ];

    const stagedSink: TraceSink = {
      kind: "blackbox",
      sinkUrl: "http://127.0.0.1:8091",
      buildExplorerTraceUrl: () => undefined,
      fetchTrace: async () => {
        const idx = Math.min(calls, stagedSnapshots.length - 1);
        calls += 1;
        return stagedSnapshots[idx]!;
      },
    };

    const resolved = await pollOutboundHttp(
      {
        ledgerView: ledger.rootView,
        sink: stagedSink,
        defaults: { pollTimeoutMs: 500, pollIntervalMs: 20, settleMs: 20 },
      },
      {
        triggeredBy: { method: "POST", path: "/api/workspaces/:id/invites" },
        method: "POST",
        url: /api\.resend\.com\/emails$/,
        status: [200, 299],
      },
    );
    expect(resolved.url).toBe("https://api.resend.com/emails");
    expect(calls).toBe(3);

    await expect(
      pollOutboundHttp(
        {
          ledgerView: ledger.rootView,
          sink: stagedSink,
          defaults: { pollTimeoutMs: 100, pollIntervalMs: 25, settleMs: 20 },
        },
        {
          triggeredBy: { method: "POST", path: "/api/workspaces/:id/invites" },
          url: /nonexistent-service/,
        },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        isTraceAssertionError(err) &&
        err instanceof TraceAssertionError &&
        err.observedCalls.length === 1 &&
        err.message.includes("https://api.resend.com/emails")
      );
    });
  });

  it("swallows staging filesystem collisions in stageVerifiedTraceRecord without throwing", () => {
    if (!isTraceId(VALID_TRACE_ID)) throw new Error("expected valid trace id");
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "sp-e2e-stage-collision-"));
    try {
      const blockingFile = path.join(tempDir, ".e2e");
      writeFileSync(blockingFile, "not-a-directory", "utf8");
      expect(() =>
        stageVerifiedTraceRecord({
          runId: "run-collision-1",
          projectRoot: tempDir,
          targetName: "web",
          attemptId: "attempt-1",
          artifactsDir: undefined,
          event: {
            traceId: VALID_TRACE_ID,
            sinkKind: "blackbox",
            sinkUrl: "http://127.0.0.1:8091",
            mode: "expectNoOutboundHttp",
            trigger: {
              traceId: VALID_TRACE_ID,
              method: "POST",
              url: "http://127.0.0.1:3000/api/ping",
              pathname: "/api/ping",
              origin: "http://127.0.0.1:3000",
              headerSource: "minted",
              startedAt: 1,
            },
          },
        }),
      ).not.toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
