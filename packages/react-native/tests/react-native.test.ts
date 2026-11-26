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
import { recordedSemanticActionSchema } from "../../e2e/dist/internal/ui-action-schema.js";
import {
  createNavigationStateChangeHandler,
  createReactNativeActionRecorder,
  createResponderProps,
  getActiveRouteNameFromState,
  initSoftprobeReactNative,
  installSoftprobeReactNative,
  instrumentReactNativeFetch,
  instrumentReactNativeXhr,
  serializeReadableSpansToOtlpJson,
  SoftprobeMobileSpanProcessor,
  wrapTextInputHandlers,
  type RecordedSemanticAction,
  type XmlHttpRequestConstructorLike,
  type XmlHttpRequestLike,
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

function extractValidatedUiActionsFromOtlp(
  resourceSpans: readonly unknown[],
  expectedSessionId: string,
) {
  const actions: ReturnType<typeof recordedSemanticActionSchema.parse>[] = [];
  for (const rs of resourceSpans) {
    const scopeSpans =
      (
        rs as {
          readonly scopeSpans?: ReadonlyArray<{
            readonly spans?: ReadonlyArray<{
              readonly name?: string;
              readonly attributes?: ReadonlyArray<{
                readonly key?: string;
                readonly value?: {
                  readonly stringValue?: string;
                  readonly intValue?: string | number;
                };
              }>;
            }>;
          }>;
        }
      ).scopeSpans ?? [];
    for (const ss of scopeSpans) {
      for (const sp of ss.spans ?? []) {
        if (sp.name !== "softprobe.ui.action") continue;
        const attrs = Object.fromEntries(
          (sp.attributes ?? []).map((kv) => [
            kv.key ?? "",
            kv.value?.stringValue ?? String(kv.value?.intValue ?? ""),
          ]),
        );
        expect(attrs["sp.session.id"]).toBe(expectedSessionId);
        expect(attrs["sp.ui.action.schema"]).toBe("sp-ui-action-1");
        const rawPayload = attrs["sp.ui.action.payload"] ?? "";
        expect(rawPayload.startsWith("sp.json:")).toBe(true);
        actions.push(
          recordedSemanticActionSchema.parse(
            JSON.parse(rawPayload.slice("sp.json:".length)),
          ),
        );
      }
    }
  }
  return actions.sort((a, b) => a.actionIndex - b.actionIndex);
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

  it("records mobile gestures and navigation transitions and feeds cleanly into @softprobe/e2e session TriggerSource and ui-action-schema", async () => {
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

    const validatedActions = extractValidatedUiActionsFromOtlp(
      mergedResourceSpans,
      "sp-rn-e2e-compat-1",
    );
    const secretSlots = [
      ...new Set(
        validatedActions.flatMap((action) =>
          action.verb.name === "fill" && action.verb.value.kind === "secret"
            ? [action.verb.value.slot]
            : [],
        ),
      ),
    ];
    expect(secretSlots).toEqual(["INVITE_PASSWORD"]);
    expect(validatedActions.map((a) => a.verb.name)).toEqual([
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

    const clickAction = validatedActions.find((a) => a.verb.name === "click");
    expect(clickAction?.endPath).toBe("/InviteSuccess");
    expect(clickAction?.captureSource).toBe("otel_sdk");
    expect(clickAction?.platform).toBe("android");
    expect(clickAction?.causedTraces).toEqual([
      expect.objectContaining({
        traceId: inviteTraceId,
        method: "POST",
        url: "https://api.acme.test/api/invites",
        status: 200,
      }),
    ]);

    abortController.abort();
    await rn.shutdown();
  });

  it("instruments XMLHttpRequest with traceparent + baggage propagation, CLIENT spans, header/body redaction, causedTraces linkage, and clean uninstall", async () => {
    interface CapturedXhrCall {
      readonly method: string;
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly body: unknown;
    }

    const observedXhrCalls: CapturedXhrCall[] = [];
    let nextXhrHandler: ((xhr: MockXmlHttpRequest) => void) | undefined;

    class MockXmlHttpRequest implements XmlHttpRequestLike {
      method = "";
      url = "";
      requestHeaders = new Map<string, string>();
      status = 0;
      response: unknown = undefined;
      responseText = "";
      readyState = 0;
      onreadystatechange: (() => void) | null = null;
      private responseHeaders = new Map<string, string>();
      private listeners = new Map<string, Set<() => void>>();

      open(method: string, url: string): void {
        this.method = method;
        this.url = url;
        this.requestHeaders = new Map();
        this.readyState = 1;
      }

      setRequestHeader(name: string, value: string): void {
        const lower = name.toLowerCase();
        const existing = this.requestHeaders.get(lower);
        this.requestHeaders.set(lower, existing ? `${existing}, ${value}` : value);
      }

      send(body?: unknown): void {
        const headersObj = Object.fromEntries(this.requestHeaders.entries());
        observedXhrCalls.push({
          method: this.method,
          url: this.url,
          headers: headersObj,
          body,
        });
        nextXhrHandler?.(this);
      }

      complete(
        status: number,
        responseText: string,
        responseHeaders: Record<string, string> = { "content-type": "application/json" },
      ): void {
        this.status = status;
        this.responseText = responseText;
        this.response = responseText;
        this.readyState = 4;
        this.responseHeaders = new Map(
          Object.entries(responseHeaders).map(([k, v]) => [k.toLowerCase(), v]),
        );
        this.onreadystatechange?.();
        for (const listener of this.listeners.get("loadend") ?? []) {
          listener();
        }
      }

      getResponseHeader(name: string): string | null {
        return this.responseHeaders.get(name.toLowerCase()) ?? null;
      }

      getAllResponseHeaders(): string {
        return [...this.responseHeaders.entries()]
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
      }

      addEventListener(type: string, listener: () => void): void {
        let set = this.listeners.get(type);
        if (!set) {
          set = new Set();
          this.listeners.set(type, set);
        }
        set.add(listener);
      }

      removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
      }
    }

    const origOpen = MockXmlHttpRequest.prototype.open;
    const origSetHeader = MockXmlHttpRequest.prototype.setRequestHeader;
    const origSend = MockXmlHttpRequest.prototype.send;

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    const xhrHost: { XMLHttpRequest: XmlHttpRequestConstructorLike } = {
      XMLHttpRequest: MockXmlHttpRequest,
    };

    const rn = installSoftprobeReactNative({
      tracerProvider: provider,
      platform: "ios",
      serviceName: "xhr-mobile-app",
      sessionId: "rn-xhr-session-7",
      apiOrigins: ["https://api.acme.test"],
      ignoreUrls: ["https://api.acme.test/health"],
      httpBodyCapture: {
        routes: [{ method: "POST", path: "/v1/orders/*" }],
        redactJsonPaths: ["$.payment.cardNumber"],
      },
      fetchImpl: async () => new Response(null, { status: 204 }),
      instrumentGlobalFetch: false,
      instrumentGlobalXhr: true,
      xhrTarget: xhrHost,
      quietMs: 15,
    });

    // 1. Trigger an XHR inside recordTap and verify causedTraces + redaction + propagation
    let activeXhr: MockXmlHttpRequest | undefined;
    nextXhrHandler = (xhr) => {
      activeXhr = xhr;
    };

    rn.actions.recordTap({ testId: "submit_order", role: "button", label: "Submit" });

    const orderXhr = new MockXmlHttpRequest();
    orderXhr.open("POST", "https://api.acme.test/v1/orders/ord_123");
    orderXhr.setRequestHeader("Content-Type", "application/json");
    orderXhr.setRequestHeader("Authorization", "Bearer xhr-secret-jwt");
    orderXhr.setRequestHeader("baggage", "tenant=acme");
    orderXhr.send(
      JSON.stringify({
        orderId: "ord_123",
        payment: { cardNumber: "4111222233334444", last4: "4444" },
      }),
    );

    expect(activeXhr).toBe(orderXhr);
    // Action should still be settling while XHR is in-flight
    expect(rn.actions.hasPendingWork()).toBe(true);

    orderXhr.complete(
      201,
      JSON.stringify({ ok: true, token: "server-secret-token", id: "ord_123" }),
      {
        "content-type": "application/json",
        "set-cookie": "sid=xhr-secret-cookie",
      },
    );

    await rn.actions.waitForIdle();

    // 2. Ignored URL and non-matching origin should not be instrumented
    nextXhrHandler = (xhr) => xhr.complete(200, '{"ok":true}');
    const ignoredXhr = new MockXmlHttpRequest();
    ignoredXhr.open("GET", "https://api.acme.test/health");
    ignoredXhr.send();

    const thirdPartyXhr = new MockXmlHttpRequest();
    thirdPartyXhr.open("GET", "https://other.example.com/ping");
    thirdPartyXhr.send();

    expect(observedXhrCalls).toHaveLength(3);
    expect(observedXhrCalls[0]?.headers.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    expect(observedXhrCalls[0]?.headers.baggage).toBe(
      "tenant=acme, sp.session.id=rn-xhr-session-7",
    );
    expect(observedXhrCalls[1]?.headers.traceparent).toBeUndefined();
    expect(observedXhrCalls[2]?.headers.traceparent).toBeUndefined();

    const spans = exporter.getFinishedSpans();
    const xhrSpan = spans.find((s) => s.name === "HTTP POST");
    expect(xhrSpan).toBeDefined();
    expect(xhrSpan?.kind).toBe(SpanKind.CLIENT);
    expect(xhrSpan?.attributes["http.request.method"]).toBe("POST");
    expect(xhrSpan?.attributes["url.full"]).toBe("https://api.acme.test/v1/orders/ord_123");
    expect(xhrSpan?.attributes["url.template"]).toBe("/v1/orders/*");
    expect(xhrSpan?.attributes["http.response.status_code"]).toBe(201);
    expect(xhrSpan?.attributes["sp.session.id"]).toBe("rn-xhr-session-7");
    expect(xhrSpan?.attributes["session.id"]).toBe("rn-xhr-session-7");
    expect(xhrSpan?.attributes["sp.body.capture.status"]).toBe("captured");

    const serialized = JSON.stringify(serializeReadableSpansToOtlpJson(spans));
    expect(serialized).not.toContain("xhr-secret-jwt");
    expect(serialized).not.toContain("4111222233334444");
    expect(serialized).not.toContain("server-secret-token");
    expect(serialized).not.toContain("xhr-secret-cookie");

    expect(JSON.parse(String(xhrSpan?.attributes["http.request.body"]))).toEqual({
      orderId: "ord_123",
      payment: { cardNumber: "[REDACTED]", last4: "4444" },
    });
    expect(JSON.parse(String(xhrSpan?.attributes["http.response.body"]))).toEqual({
      ok: true,
      token: "[REDACTED]",
      id: "ord_123",
    });

    const uiActionSpan = spans.find((s) => s.name === "softprobe.ui.action");
    expect(uiActionSpan).toBeDefined();
    const actionPayload = decodeActionPayload(uiActionSpan?.attributes["sp.ui.action.payload"]);
    expect(actionPayload.causedTraces).toEqual([
      {
        traceId: xhrSpan?.spanContext().traceId,
        spanId: xhrSpan?.spanContext().spanId,
        method: "POST",
        url: "https://api.acme.test/v1/orders/ord_123",
        urlTemplate: "/v1/orders/*",
        status: 201,
      },
    ]);

    // 3. Uninstall restores original XMLHttpRequest.prototype methods
    expect(MockXmlHttpRequest.prototype.open).not.toBe(origOpen);
    rn.uninstall();
    expect(MockXmlHttpRequest.prototype.open).toBe(origOpen);
    expect(MockXmlHttpRequest.prototype.setRequestHeader).toBe(origSetHeader);
    expect(MockXmlHttpRequest.prototype.send).toBe(origSend);

    // Standalone instrumentReactNativeXhr also respects uninstall
    const standalone = instrumentReactNativeXhr({
      tracer: provider.getTracer("standalone-xhr"),
      getSessionId: () => "standalone-session",
      xhrConstructor: MockXmlHttpRequest,
    });
    expect(MockXmlHttpRequest.prototype.send).not.toBe(origSend);
    standalone.uninstall();
    expect(MockXmlHttpRequest.prototype.send).toBe(origSend);

    await provider.shutdown();
  });

  it("extracts React Navigation routes and wraps root responder + TextInput handlers with secureTextEntry redaction", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new SoftprobeMobileSpanProcessor({
          platform: "android",
          serviceName: "nav-helper-app",
          sessionId: "rn-nav-helper-session",
        }),
        new SimpleSpanProcessor(exporter),
      ],
    });
    const actions = createReactNativeActionRecorder({
      tracer: provider.getTracer("nav-helper"),
      platform: "android",
      initialRoute: "Home",
      quietMs: 10,
    });

    // Nested React Navigation state extraction
    expect(
      getActiveRouteNameFromState({
        index: 1,
        routes: [
          { name: "Home" },
          {
            name: "MainTabs",
            state: {
              index: 0,
              routes: [{ name: "CheckoutScreen" }, { name: "ProfileScreen" }],
            },
          },
        ],
      }),
    ).toBe("CheckoutScreen");
    expect(getActiveRouteNameFromState(undefined)).toBeUndefined();

    const onStateChange = createNavigationStateChangeHandler(actions);
    onStateChange({
      index: 0,
      routes: [
        {
          name: "RootStack",
          state: {
            index: 1,
            routes: [{ name: "Home" }, { name: "Login" }],
          },
        },
      ],
    });
    await actions.waitForIdle();

    // TextInput handler wrapping with secureTextEntry redaction + forwarding
    const observedTextChanges: string[] = [];
    let endEditingCalled = false;
    const passwordRaw = "UltraSecretPass!99";

    const passwordInputProps = wrapTextInputHandlers(
      actions,
      { testId: "login_password", role: "textbox", label: "Password" },
      {
        secureTextEntry: true,
        onChangeText: (text) => observedTextChanges.push(text),
        onEndEditing: () => {
          endEditingCalled = true;
        },
      },
    );

    passwordInputProps.onChangeText("Ultra");
    passwordInputProps.onChangeText(passwordRaw);
    passwordInputProps.onEndEditing({ nativeEvent: { text: passwordRaw } });
    // Calling onBlur right after onEndEditing should not emit a duplicate fill
    passwordInputProps.onBlur({});
    await actions.waitForIdle();

    expect(observedTextChanges).toEqual(["Ultra", passwordRaw]);
    expect(endEditingCalled).toBe(true);

    // Root responder props wrapping
    let responderReleased = false;
    const responderProps = createResponderProps(
      actions,
      { testId: "login_submit", role: "button", label: "Sign in" },
      {
        onResponderRelease: () => {
          responderReleased = true;
        },
      },
    );

    expect(responderProps.onStartShouldSetResponder({})).toBe(true);
    responderProps.onResponderRelease({
      nativeEvent: { pageX: 142.4, pageY: 518.7 },
    });
    await actions.waitForIdle();
    expect(responderReleased).toBe(true);

    const spans = exporter.getFinishedSpans();
    const serialized = JSON.stringify(serializeReadableSpansToOtlpJson(spans));
    expect(serialized).not.toContain(passwordRaw);

    const recorded = spans
      .filter((s) => s.name === "softprobe.ui.action")
      .map((s) => decodeActionPayload(s.attributes["sp.ui.action.payload"]));

    expect(recorded).toHaveLength(3);
    expect(recorded[0]?.verb).toEqual({
      name: "navigate",
      url: "/Login",
      trigger: "pushState",
    });
    expect(recorded[1]?.verb).toEqual({
      name: "fill",
      target: { testId: "login_password", role: "textbox", label: "Password" },
      value: { kind: "secret", slot: "PASSWORD" },
      replace: true,
    });
    expect(recorded[2]?.verb).toEqual({
      name: "click",
      target: { testId: "login_submit", role: "button", label: "Sign in" },
      point: { x: 142, y: 519 },
    });

    actions.shutdown();
    await provider.shutdown();
  });
});
