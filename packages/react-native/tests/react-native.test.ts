import { SpanKind } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createTraceScope } from "../../e2e/dist/fixtures.js";
import { BlackboxSink } from "../../e2e/dist/internal/blackbox-sink.js";
import {
  createBlackboxSessionTriggerSource,
  extractSessionTriggersFromPayload,
} from "../../e2e/dist/internal/trigger-source.js";
import { extractSessionBundleFromSpans } from "../../e2e/dist/session-compiler.js";
import {
  createReactNativeActionRecorder,
  initSoftprobeReactNative,
  installSoftprobeReactNative,
  instrumentReactNativeFetch,
  serializeReadableSpansToOtlpJson,
  SoftprobeMobileSpanProcessor,
  type RecordedSemanticAction,
} from "../src/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeActionPayload(raw: unknown): RecordedSemanticAction {
  expect(typeof raw).toBe("string");
  const str = String(raw);
  expect(str.startsWith("sp.json:")).toBe(true);
  return JSON.parse(str.slice("sp.json:".length)) as RecordedSemanticAction;
}

describe("@softprobe/react-native OpenTelemetry extensions", () => {
  it("resolves sessionId from key-value and CLI-array launchArguments and stamps spans + W3C baggage", async () => {
    const exporterKv = new InMemorySpanExporter();
    const providerKv = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporterKv)],
    });

    const observedHeaders: Array<Record<string, string>> = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const plain: Record<string, string> = {};
      headers.forEach((value, key) => {
        plain[key.toLowerCase()] = value;
      });
      observedHeaders.push(plain);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const rnKv = installSoftprobeReactNative({
      tracerProvider: providerKv,
      platform: "android",
      serviceName: "invite-rn-android",
      launchArguments: { sp_session_id: "rn-kv-session-42" },
      apiOrigins: ["https://api.acme.test"],
      fetchImpl: mockFetch,
      instrumentGlobalFetch: false,
    });

    expect(rnKv.sessionId).toBe("rn-kv-session-42");

    await rnKv.fetch("https://api.acme.test/api/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        baggage: "tenant=acme",
      },
      body: JSON.stringify({ email: "ada@acme.com" }),
    });

    expect(observedHeaders).toHaveLength(1);
    expect(observedHeaders[0]?.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    expect(observedHeaders[0]?.baggage).toBe(
      "tenant=acme,sp.session.id=rn-kv-session-42",
    );

    const kvSpans = exporterKv.getFinishedSpans();
    expect(kvSpans).toHaveLength(1);
    expect(kvSpans[0]?.kind).toBe(SpanKind.CLIENT);
    expect(kvSpans[0]?.attributes["sp.session.id"]).toBe("rn-kv-session-42");
    expect(kvSpans[0]?.attributes["session.id"]).toBe("rn-kv-session-42");
    expect(kvSpans[0]?.attributes["sp.platform"]).toBe("android");
    expect(kvSpans[0]?.attributes["service.name"]).toBe("invite-rn-android");

    const exporterCli = new InMemorySpanExporter();
    const cliProcessor = new SoftprobeMobileSpanProcessor({
      platform: "ios",
      serviceName: "invite-rn-ios",
      launchArguments: ["-AppleLanguages", "(en)", "-spSessionId", "rn-cli-session-99"],
    });
    const providerCli = new BasicTracerProvider({
      spanProcessors: [cliProcessor, new SimpleSpanProcessor(exporterCli)],
    });

    const tracerCli = providerCli.getTracer("app-test");
    const customSpan = tracerCli.startSpan("custom.mobile.operation");
    customSpan.end();

    const cliSpans = exporterCli.getFinishedSpans();
    expect(cliSpans).toHaveLength(1);
    expect(cliSpans[0]?.attributes["sp.session.id"]).toBe("rn-cli-session-99");
    expect(cliSpans[0]?.attributes["sp.platform"]).toBe("ios");
    expect(cliSpans[0]?.attributes["service.name"]).toBe("invite-rn-ios");

    await rnKv.shutdown();
    await providerCli.shutdown();
  });

  it("redacts secureTextEntry, password inputPurpose, secretSlots, auth headers, and redactJsonPaths with zero raw leakage", async () => {
    const exporter = new InMemorySpanExporter();
    const spanProcessor = new SoftprobeMobileSpanProcessor({
      platform: "ios",
      serviceName: "vault-mobile",
      sessionId: "rn-redaction-session",
    });
    const provider = new BasicTracerProvider({
      spanProcessors: [spanProcessor, new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("vault");

    const actions = createReactNativeActionRecorder({
      tracer,
      platform: "ios",
      quietMs: 10,
      secretSlots: {
        api_token_field: "WORKSPACE_API_TOKEN",
        "accessibility-pin": "PIN_CODE",
      },
    });

    const fetchHandle = instrumentReactNativeFetch({
      tracer,
      getSessionId: () => spanProcessor.getSessionId(),
      actionRecorder: actions,
      redactJsonPaths: ["$.paymentDetails.cardNumber", "$.recipients[*].otp"],
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            apiKey: "live-server-api-key-999",
            paymentDetails: { cardNumber: "4111222233334444", last4: "4444" },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": "sid=top-secret-cookie",
            },
          },
        ),
    });

    const rawPassword = "SuperSecretPassword!2026";
    const rawApiToken = "sp_live_secret_token_abc123";
    const rawPin = "948201";
    const rawCard = "4111222233334444";
    const rawBearer = "Bearer ultra-secret-jwt";

    actions.recordFill(
      {
        testId: "email_input",
        role: "textbox",
        label: "Teammate email",
      },
      "ada@acme.com",
    );
    await actions.waitForIdle();

    actions.recordFill(
      {
        testId: "password_input",
        role: "textbox",
        label: "Password",
        value: rawPassword,
      },
      rawPassword,
      { secureTextEntry: true },
    );
    await actions.waitForIdle();

    actions.recordFill(
      {
        testId: "api_token_field",
        role: "textbox",
        label: "API Token",
      },
      rawApiToken,
    );
    await actions.waitForIdle();

    actions.recordFill(
      {
        accessibilityId: "accessibility-pin",
        role: "textbox",
        inputPurpose: "password",
      },
      rawPin,
    );
    await actions.waitForIdle();

    await fetchHandle.fetch("https://api.acme.test/v1/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: rawBearer,
        Cookie: "session=raw-cookie-val",
        apikey: "raw-header-apikey",
      },
      body: JSON.stringify({
        email: "ada@acme.com",
        password: rawPassword,
        paymentDetails: {
          cardNumber: rawCard,
          brand: "visa",
        },
        recipients: [{ otp: "778899" }],
      }),
    });

    const spans = exporter.getFinishedSpans();
    const otlpPayload = serializeReadableSpansToOtlpJson(spans);
    const serializedAll = JSON.stringify(otlpPayload);

    expect(serializedAll).not.toContain(rawPassword);
    expect(serializedAll).not.toContain(rawApiToken);
    expect(serializedAll).not.toContain(rawPin);
    expect(serializedAll).not.toContain(rawCard);
    expect(serializedAll).not.toContain("ultra-secret-jwt");
    expect(serializedAll).not.toContain("raw-cookie-val");
    expect(serializedAll).not.toContain("raw-header-apikey");
    expect(serializedAll).not.toContain("top-secret-cookie");
    expect(serializedAll).not.toContain("live-server-api-key-999");
    expect(serializedAll).not.toContain("778899");

    const uiActions = spans
      .filter((s) => s.name === "softprobe.ui.action")
      .map((s) => decodeActionPayload(s.attributes["sp.ui.action.payload"]));

    expect(uiActions).toHaveLength(4);
    expect(uiActions[0]?.verb).toEqual({
      name: "fill",
      target: { testId: "email_input", role: "textbox", label: "Teammate email" },
      value: { kind: "literal", value: "ada@acme.com" },
      replace: true,
    });
    expect(uiActions[1]?.verb).toEqual({
      name: "fill",
      target: { testId: "password_input", role: "textbox", label: "Password" },
      value: { kind: "secret", slot: "PASSWORD" },
      replace: true,
    });
    expect(uiActions[2]?.verb).toEqual({
      name: "fill",
      target: { testId: "api_token_field", role: "textbox", label: "API Token" },
      value: { kind: "secret", slot: "WORKSPACE_API_TOKEN" },
      replace: true,
    });
    expect(uiActions[3]?.verb).toEqual({
      name: "fill",
      target: {
        accessibilityId: "accessibility-pin",
        role: "textbox",
        inputPurpose: "password",
      },
      value: { kind: "secret", slot: "PIN_CODE" },
      replace: true,
    });

    const httpSpan = spans.find((s) => s.name === "HTTP POST");
    expect(httpSpan).toBeDefined();
    const capturedReq = JSON.parse(String(httpSpan?.attributes["http.request.body"]));
    expect(capturedReq).toEqual({
      email: "ada@acme.com",
      password: "[REDACTED]",
      paymentDetails: {
        cardNumber: "[REDACTED]",
        brand: "visa",
      },
      recipients: [{ otp: "[REDACTED]" }],
    });

    const capturedRes = JSON.parse(String(httpSpan?.attributes["http.response.body"]));
    expect(capturedRes).toEqual({
      ok: true,
      apiKey: "[REDACTED]",
      paymentDetails: {
        cardNumber: "[REDACTED]",
        last4: "4444",
      },
    });

    fetchHandle.uninstall();
    actions.shutdown();
    await provider.shutdown();
  });

  it("waits for concurrent in-flight fetches triggered inside recordTap and attaches causedTraces + endAnchors", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    let bannerText = "";
    const rn = installSoftprobeReactNative({
      tracerProvider: provider,
      platform: "android",
      serviceName: "team-invite-rn",
      sessionId: "rn-settle-session",
      initialRoute: "TeamInvite",
      quietMs: 25,
      apiOrigins: ["https://api.acme.test"],
      observeAnchors: () =>
        bannerText
          ? [{ role: "status", testId: "status_banner", text: bannerText }]
          : [],
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/invites")) {
          await delay(60);
          return new Response(JSON.stringify({ inviteId: "inv_901" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/audit")) {
          await delay(90);
          return new Response(JSON.stringify({ logged: true }), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("ok", { status: 200 });
      },
      instrumentGlobalFetch: false,
    });

    rn.actions.recordTap(
      {
        testId: "send_invite_button",
        role: "button",
        name: "Send invite",
        rect: { x: 20, y: 400, width: 200, height: 48 },
      },
    );

    const p1 = rn.fetch("https://api.acme.test/api/invites", {
      method: "POST",
      body: JSON.stringify({ email: "ada@acme.com" }),
    });
    const p2 = rn.fetch("https://api.acme.test/api/audit", {
      method: "POST",
      body: JSON.stringify({ action: "invite" }),
    });
    const ignoredExternal = rn.fetch("https://cdn.unrelated.example/logo.png");

    await delay(40);
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "softprobe.ui.action"),
    ).toHaveLength(0);

    await Promise.all([p1, p2, ignoredExternal]);
    bannerText = "Invitation queued for ada@acme.com";

    await rn.actions.waitForIdle();

    const finished = exporter.getFinishedSpans();
    const httpSpans = finished.filter((s) => s.kind === SpanKind.CLIENT);
    expect(httpSpans).toHaveLength(2);

    const actionSpans = finished.filter((s) => s.name === "softprobe.ui.action");
    expect(actionSpans).toHaveLength(1);
    const action = decodeActionPayload(actionSpans[0]?.attributes["sp.ui.action.payload"]);

    expect(action.captureSource).toBe("otel_sdk");
    expect(action.platform).toBe("android");
    expect(action.startPath).toBe("/TeamInvite");
    expect(action.endPath).toBe("/TeamInvite");
    expect(action.settleMs).toBeGreaterThanOrEqual(90);
    expect(action.verb).toEqual({
      name: "click",
      target: {
        testId: "send_invite_button",
        role: "button",
        name: "Send invite",
        rect: { x: 20, y: 400, width: 200, height: 48 },
      },
      point: { x: 120, y: 424 },
    });
    expect(action.causedTraces).toHaveLength(2);
    expect(action.causedTraces.map((c) => ({ url: c.url, status: c.status }))).toEqual([
      { url: "https://api.acme.test/api/invites", status: 201 },
      { url: "https://api.acme.test/api/audit", status: 202 },
    ]);
    for (const httpSpan of httpSpans) {
      expect(action.causedTraces.map((c) => c.traceId)).toContain(
        httpSpan.spanContext().traceId,
      );
    }
    expect(action.endAnchors).toEqual([
      {
        role: "status",
        testId: "status_banner",
        text: "Invitation queued for ada@acme.com",
      },
    ]);

    await rn.shutdown();
  });

  it("records mobile gestures and navigation transitions and feeds cleanly into @softprobe/e2e session TriggerSource + compiler", async () => {
    const otlpBatches: unknown[] = [];

    const rn = initSoftprobeReactNative({
      endpoint: "https://collector.acme.test",
      ingestionKey: "sp_ing_test_key",
      platform: "android",
      serviceName: "invite-rn-e2e",
      launchArguments: ["-spSessionId", "sp-rn-e2e-compat-1"],
      quietMs: 15,
      secretSlots: { password_input: "INVITE_PASSWORD" },
      instrumentGlobalFetch: false,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === "https://collector.acme.test/v1/traces") {
          const auth = new Headers(init?.headers).get("authorization");
          expect(auth).toBe("Bearer sp_ing_test_key");
          otlpBatches.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ partialSuccess: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://api.acme.test/api/invites") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    rn.actions.onNavigationRouteChange("InviteForm", { team: "core" });
    await rn.actions.waitForIdle();

    rn.actions.recordFill(
      { testId: "email_input", role: "textbox", name: "Teammate email" },
      "ada@acme.com",
    );
    await rn.actions.waitForIdle();

    rn.actions.recordFill(
      { testId: "password_input", role: "textbox", name: "Password" },
      "top-secret-pw!",
      { secureTextEntry: true },
    );
    await rn.actions.waitForIdle();

    rn.actions.recordDismissKeyboard();
    await rn.actions.waitForIdle();

    rn.actions.recordSwipe(
      "up",
      { testId: "invite_scroll", role: "scrollview" },
      0.5,
    );
    await rn.actions.waitForIdle();

    rn.actions.recordLongPress(
      { testId: "role_badge", role: "button", name: "Admin" },
      { durationMs: 650, point: { x: 80, y: 310 } },
    );
    await rn.actions.waitForIdle();

    rn.actions.recordTap(
      { testId: "send_invite_button", role: "button", name: "Send invite" },
      { x: 180, y: 520 },
    );
    const inviteRes = await rn.fetch("https://api.acme.test/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@acme.com", password: "top-secret-pw!" }),
    });
    expect(inviteRes.status).toBe(200);
    rn.actions.onNavigationRouteChange("InviteSuccess");
    rn.actions.recordEndAnchors([
      { role: "status", text: "Invitation queued for ada@acme.com" },
    ]);
    await rn.actions.waitForIdle();

    rn.actions.onNavigationRouteChange("acme://settings/team");
    await rn.actions.waitForIdle();

    rn.actions.recordBack({ toRoute: "InviteForm" });
    await rn.actions.waitForIdle();

    await rn.flush();

    const mergedResourceSpans = otlpBatches.flatMap((batch) => {
      const rec = batch as { readonly resourceSpans?: readonly unknown[] };
      return rec.resourceSpans ?? [];
    });
    expect(mergedResourceSpans.length).toBeGreaterThan(0);

    const sessionEnvelope = {
      session_id: "sp-rn-e2e-compat-1",
      resourceSpans: mergedResourceSpans,
    };

    const triggers = extractSessionTriggersFromPayload(sessionEnvelope);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.method).toBe("POST");
    expect(triggers[0]?.pathname).toBe("/api/invites");
    const inviteTraceId = triggers[0]!.traceId;

    const backendTraceEnvelope = {
      trace: {
        resourceSpans: [
          ...mergedResourceSpans,
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "invite-api" } },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "obi" },
                spans: [
                  {
                    traceId: inviteTraceId,
                    spanId: "1111111111111111",
                    parentSpanId: triggers[0]?.spanId,
                    name: "POST /api/invites",
                    kind: 2,
                    startTimeUnixNano: "1700000000100000000",
                    endTimeUnixNano: "1700000000150000000",
                    attributes: [
                      { key: "http.request.method", value: { stringValue: "POST" } },
                      { key: "http.route", value: { stringValue: "/api/invites" } },
                      { key: "http.response.status_code", value: { intValue: "200" } },
                    ],
                  },
                  {
                    traceId: inviteTraceId,
                    spanId: "2222222222222222",
                    parentSpanId: "1111111111111111",
                    name: "POST /v1/email/send",
                    kind: 3,
                    startTimeUnixNano: "1700000000110000000",
                    endTimeUnixNano: "1700000000140000000",
                    attributes: [
                      { key: "http.request.method", value: { stringValue: "POST" } },
                      {
                        key: "url.full",
                        value: { stringValue: "https://mailer.internal/v1/email/send" },
                      },
                      { key: "http.response.status_code", value: { intValue: "200" } },
                      {
                        key: "http.request.body",
                        value: { stringValue: JSON.stringify({ to: "ada@acme.com" }) },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const sinkFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/llm/sessions/sp-rn-e2e-compat-1")) {
        return new Response(JSON.stringify(sessionEnvelope), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes(`/api/traces/${inviteTraceId}`)) {
        return new Response(JSON.stringify(backendTraceEnvelope), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const triggerSource = createBlackboxSessionTriggerSource({
      endpoint: "https://blackbox.acme.test",
      sessionId: "sp-rn-e2e-compat-1",
      fetchImpl: sinkFetch,
    });
    const sink = new BlackboxSink({
      endpoint: "https://blackbox.acme.test",
      fetchImpl: sinkFetch,
    });
    const abortController = new AbortController();
    const traceScope = createTraceScope({
      triggerSource,
      resolveSink: () => sink,
      pollingDefaults: { pollTimeoutMs: 2_000, pollIntervalMs: 50, settleMs: 20 },
      signal: abortController.signal,
    });

    const outbound = await traceScope.outboundHttp({
      triggeredBy: { method: "POST", path: "/api/invites" },
      method: "POST",
      url: "/v1/email/send",
      status: 200,
    });
    expect(outbound.request.json).toEqual({ to: "ada@acme.com" });

    const compiledBundle = extractSessionBundleFromSpans(sessionEnvelope, {
      sessionId: "sp-rn-e2e-compat-1",
      tracesByTraceId: { [inviteTraceId]: backendTraceEnvelope },
    });

    expect(compiledBundle.sessionId).toBe("sp-rn-e2e-compat-1");
    expect(compiledBundle.secretSlots).toEqual(["INVITE_PASSWORD"]);
    expect(compiledBundle.outboundAssertionCount).toBe(1);
    expect(compiledBundle.steps.map((s) => s.action.verb.name)).toEqual([
      "navigate",
      "fill",
      "fill",
      "dismissKeyboard",
      "swipe",
      "longPress",
      "click",
      "openLink",
      "back",
    ]);

    const clickStep = compiledBundle.steps.find((s) => s.action.verb.name === "click");
    expect(clickStep?.action.endPath).toBe("/InviteSuccess");
    expect(clickStep?.action.captureSource).toBe("otel_sdk");
    expect(clickStep?.action.platform).toBe("android");
    expect(clickStep?.backendTraces).toHaveLength(1);
    expect(clickStep?.backendTraces[0]?.outboundCalls[0]?.request.json).toEqual({
      to: "ada@acme.com",
    });

    abortController.abort();
    await rn.shutdown();
  });
});
