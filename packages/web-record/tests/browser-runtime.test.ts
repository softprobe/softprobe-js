import { afterEach, expect, it, vi } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { createBrowserRuntime, type BrowserRuntime } from "../src/browser-runtime.js";
import { createWebSessionState } from "../src/session-state.js";

let runtime: BrowserRuntime | null = null;
let exporter: InMemorySpanExporter | null = null;

afterEach(async () => {
  await runtime?.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  runtime = null;
  exporter = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function startRuntime(maxBodyBytes = 1024): { runtime: BrowserRuntime; exporter: InMemorySpanExporter } {
  const memoryExporter = new InMemorySpanExporter();
  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    environment: "test",
    apiOrigins: ["https://api.example.test"],
    httpBodyCapture: {
      maxBodyBytes,
      routes: [{
        origin: "https://api.example.test",
        method: "POST",
        path: "/api/orders",
        redactJsonPaths: ["$.payment.cardNumber"],
      }],
    },
  }, createWebSessionState("journey-1"), memoryExporter);
  runtime = browserRuntime;
  exporter = memoryExporter;
  return { runtime: browserRuntime, exporter: memoryExporter };
}

it("uses official Fetch instrumentation and emits one HTTP span plus a redacted body child", async () => {
  let responseStreamClosed = false;
  const encoder = new TextEncoder();
  const apiResponse = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"result":"ok"}'));
      setTimeout(() => {
        responseStreamClosed = true;
        controller.close();
      }, 100);
    },
  }), { headers: { "Content-Type": "application/json" } });
  const requests: Array<{ url: string; headers: Headers }> = [];
  const originalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return String(input).startsWith("https://api.example.test")
      ? apiResponse
      : new Response("ignored", { status: 200 });
  });
  vi.stubGlobal("fetch", originalFetch);

  const { runtime: browserRuntime, exporter: memoryExporter } = startRuntime();
  const response = await fetch("https://api.example.test/api/orders?token=private", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payment: { cardNumber: "4111111111111111" }, total: 42 }),
  });

  expect(response.status).toBe(200);
  expect(responseStreamClosed).toBe(false);
  expect(requests[0]?.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  await expect(response.json()).resolves.toEqual({ result: "ok" });

  await fetch("https://sub.api.example.test/api/orders", { method: "POST" });
  expect(requests[1]?.headers.has("traceparent")).toBe(false);
  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  const spans = memoryExporter.getFinishedSpans();
  const httpSpans = spans.filter((span) => span.kind === 2);
  expect(httpSpans).toHaveLength(1);
  const parent = httpSpans[0]!;
  expect(parent.name).toBe("POST");
  expect(parent.attributes["url.template"]).toBeUndefined();
  const body = spans.find((span) => span.name === "softprobe.http.body.capture");
  expect(body).toBeDefined();
  expect(body?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(body?.spanContext().traceId).toBe(parent.spanContext().traceId);
  expect(parent.attributes).toMatchObject({
    "session.id": "journey-1",
    "sp.session.id": "journey-1",
    "url.full": "https://api.example.test/api/orders",
  });
  expect(body?.attributes).toMatchObject({
    "session.id": "journey-1",
    "sp.session.id": "journey-1",
    "sp.body.capture.status": "captured",
    "http.request.body.content": '{"payment":{"cardNumber":"[REDACTED]"},"total":42}',
    "http.response.body.content": '{"result":"ok"}',
  });
  expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("4111111111111111");
  expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("token=private");
});

it("uses official XHR instrumentation and reads the body without changing the request", async () => {
  class MockXHR extends EventTarget {
    status = 201;
    responseType: XMLHttpRequestResponseType = "";
    responseText = '{"saved":true}';
    sentBody: XMLHttpRequestBodyInit | null | undefined;
    readonly headers = new Headers();

    open(method: string, url: string | URL): void {
      this.method = method;
      this.url = String(url);
    }

    method = "GET";
    url = "";

    setRequestHeader(name: string, value: string): void {
      this.headers.append(name, value);
    }

    getResponseHeader(name: string): string | null {
      return name.toLowerCase() === "content-type" ? "application/json" : null;
    }

    send(body?: XMLHttpRequestBodyInit | null): void {
      this.sentBody = body;
      this.dispatchEvent(new Event("load"));
    }
  }
  vi.stubGlobal("XMLHttpRequest", MockXHR);
  const { runtime: browserRuntime, exporter: memoryExporter } = startRuntime();
  const xhr = new XMLHttpRequest() as unknown as MockXHR;
  xhr.open("POST", "https://api.example.test/api/orders?token=private");
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.send('{"payment":{"cardNumber":"4111111111111111"},"total":42}');

  expect(xhr.sentBody).toBe('{"payment":{"cardNumber":"4111111111111111"},"total":42}');
  expect(xhr.responseText).toBe('{"saved":true}');
  expect(xhr.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  const spans = memoryExporter.getFinishedSpans();
  const httpSpans = spans.filter((span) => span.kind === 2);
  expect(httpSpans).toHaveLength(1);
  expect(httpSpans[0]?.name).toBe("POST");
  expect(httpSpans[0]?.attributes["url.template"]).toBeUndefined();
  const body = spans.find((span) => span.name === "softprobe.http.body.capture");
  expect(body?.attributes).toMatchObject({
    "sp.body.capture.status": "captured",
    "http.request.body.content": '{"payment":{"cardNumber":"[REDACTED]"},"total":42}',
    "http.response.body.content": '{"saved":true}',
  });
});

it("binds a single API origin and redacts builtin secrets inside arrays", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', {
    headers: { "Content-Type": "application/json" },
  })));
  const memoryExporter = new InMemorySpanExporter();
  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    apiOrigins: ["https://api.example.test"],
    httpBodyCapture: {
      routes: [{ method: "POST", path: "/api/pay" }],
    },
  }, createWebSessionState("journey-1"), memoryExporter);
  runtime = browserRuntime;

  await fetch("https://api.example.test/api/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentDetails: { cardNumber: "4111111111111111", holder: "Ada" },
      charges: [{ cvv: "123", password: "hunter2", secret: "s3cret", cvc: "999", sku: "seat" }],
    }),
  });
  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  const body = memoryExporter.getFinishedSpans().find((span) => span.name === "softprobe.http.body.capture");
  expect(JSON.parse(String(body?.attributes["http.request.body.content"]))).toEqual({
    paymentDetails: { cardNumber: "[REDACTED]", holder: "Ada" },
    charges: [{ cvv: "[REDACTED]", password: "[REDACTED]", secret: "[REDACTED]", cvc: "[REDACTED]", sku: "seat" }],
  });
});

it("captures no body when several API origins leave the route origin unset", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}', {
    headers: { "Content-Type": "application/json" },
  })));
  const memoryExporter = new InMemorySpanExporter();
  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    apiOrigins: ["https://api.example.test", "https://pay.example.test"],
    httpBodyCapture: {
      routes: [{ method: "POST", path: "/api/pay" }],
    },
  }, createWebSessionState("journey-1"), memoryExporter);
  runtime = browserRuntime;

  await fetch("https://api.example.test/api/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentDetails: { cardNumber: "4111111111111111" } }),
  });
  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  const body = memoryExporter.getFinishedSpans().find((span) => span.name === "softprobe.http.body.capture");
  expect(body).toBeUndefined();
});

it("defaults to window.location.origin and route origins when apiOrigins is omitted", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response('{"status":"ok"}', {
      headers: { "Content-Type": "application/json" },
    });
  }));
  const memoryExporter = new InMemorySpanExporter();
  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    httpBodyCapture: {
      routes: [
        { method: "POST", path: "/api/flights/search" },
        {
          method: "POST",
          path: "https://api.checkout.example.test:8443/api/orders/checkout",
          redactJsonPaths: ["$.payment.billingTaxId"],
        },
      ],
    },
  }, createWebSessionState("journey-default-origins"), memoryExporter);
  runtime = browserRuntime;

  await fetch(`${window.location.origin}/api/flights/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "LHR", to: "CDG" }),
  });
  await fetch("https://api.checkout.example.test:8443/api/orders/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payment: { cardNumber: "4111111111111111", billingTaxId: "TAX-999" },
    }),
  });
  await fetch("https://third-party.example.test/collect", { method: "POST" });

  expect(requests[0]?.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(requests[1]?.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(requests[2]?.headers.has("traceparent")).toBe(false);

  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  const spans = memoryExporter.getFinishedSpans();
  const httpSpans = spans.filter((span) => span.kind === 2);
  expect(httpSpans).toHaveLength(2);
  const bodySpans = spans.filter((span) => span.name === "softprobe.http.body.capture");
  expect(bodySpans).toHaveLength(2);
  const checkoutBody = bodySpans.find(
    (span) => span.attributes["url.full"] === "https://api.checkout.example.test:8443/api/orders/checkout",
  );
  expect(JSON.parse(String(checkoutBody?.attributes["http.request.body.content"]))).toEqual({
    payment: { cardNumber: "[REDACTED]", billingTaxId: "[REDACTED]" },
  });
});

it("omits request and response bodies that exceed the configured byte limit", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"long":"response"}', {
    headers: { "Content-Type": "application/json" },
  })));
  const { runtime: browserRuntime, exporter: memoryExporter } = startRuntime(8);

  await fetch("https://api.example.test/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"long":"request"}',
  });
  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  const body = memoryExporter.getFinishedSpans().find((span) => span.name === "softprobe.http.body.capture");
  expect(body?.attributes).toMatchObject({ "sp.body.capture.status": "omitted" });
  expect(body?.attributes).not.toHaveProperty("http.request.body.content");
  expect(body?.attributes).not.toHaveProperty("http.response.body.content");
});

it("captures same-origin JSON bodies without a route allowlist and adopts session ids from /sessions endpoints", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/agent/api/sessions")) {
      return new Response('{"id":"ses_auto_123","provider":"google"}', {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response('{"status":"queued"}', {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }));
  const memoryExporter = new InMemorySpanExporter();
  const sessionState = createWebSessionState("initial-tab-uuid");
  const discoveredIds: string[] = [];
  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    httpBodyCapture: {},
    onSessionId: (id) => {
      discoveredIds.push(id);
      sessionState.setSessionId(id);
    },
  }, sessionState, memoryExporter);
  runtime = browserRuntime;

  const createRes = await fetch(`${window.location.origin}/agent/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  await createRes.json();

  const messageRes = await fetch(`${window.location.origin}/agent/api/sessions/ses_auto_123/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Book LHR to CDG", secret: "top-secret" }),
  });
  await messageRes.json();

  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  expect(discoveredIds).toContain("ses_auto_123");
  expect(sessionState.getSessionId()).toBe("ses_auto_123");

  const spans = memoryExporter.getFinishedSpans();
  const bodySpans = spans.filter((span) => span.name === "softprobe.http.body.capture");
  expect(bodySpans).toHaveLength(2);
  for (const span of spans) {
    expect(span.attributes).toMatchObject({
      "session.id": "ses_auto_123",
      "sp.session.id": "ses_auto_123",
    });
  }
  const messageBodySpan = bodySpans.find((span) =>
    String(span.attributes["url.full"]).endsWith("/agent/api/sessions/ses_auto_123/messages"),
  );
  expect(JSON.parse(String(messageBodySpan?.attributes["http.request.body.content"]))).toEqual({
    prompt: "Book LHR to CDG",
    secret: "[REDACTED]",
  });
});

it("supports wildcard route patterns in httpBodyCapture.routes and ignores unselected polling and status routes", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url, method, headers: new Headers(init?.headers) });
    if (url.endsWith("/agent/api/status")) {
      return new Response('{"ready":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/agent/api/sessions") && method === "POST") {
      return new Response('{"id":"ses_wild_77","provider":"google"}', {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/agent/api/sessions/ses_wild_77") && method === "GET") {
      return new Response('{"id":"ses_wild_77","busy":true,"messages":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response('{"accepted":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));

  const memoryExporter = new InMemorySpanExporter();
  const sessionState = createWebSessionState("tab-pre-session");
  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    httpBodyCapture: {
      routes: [
        { method: "POST", path: "/agent/api/sessions" },
        { method: "POST", path: "/agent/api/sessions/*/messages" },
        { method: "POST", path: "/agent/api/sessions/*/pay" },
      ],
    },
    onSessionId: (id) => sessionState.setSessionId(id),
  }, sessionState, memoryExporter);
  runtime = browserRuntime;

  await (await fetch(`${window.location.origin}/agent/api/status`)).json();
  await (await fetch(`${window.location.origin}/agent/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google" }),
  })).json();
  await (await fetch(`${window.location.origin}/agent/api/sessions/ses_wild_77/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Find LHR to CDG" }),
  })).json();
  await (await fetch(`${window.location.origin}/agent/api/sessions/ses_wild_77`)).json();
  await (await fetch(`${window.location.origin}/agent/api/sessions/ses_wild_77/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "req_1",
      paymentDetails: { cardNumber: "4111111111111111", cvv: "123" },
    }),
  })).json();

  await browserRuntime.waitForIdle();
  await browserRuntime.forceFlush();

  expect(requests.find((r) => r.url.endsWith("/agent/api/status"))?.headers.has("traceparent")).toBe(false);
  expect(
    requests.find((r) => r.method === "GET" && r.url.endsWith("/agent/api/sessions/ses_wild_77"))?.headers.has("traceparent"),
  ).toBe(false);
  expect(requests.find((r) => r.url.endsWith("/agent/api/sessions"))?.headers.get("traceparent")).toMatch(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
  );
  expect(
    requests.find((r) => r.url.endsWith("/agent/api/sessions/ses_wild_77/messages"))?.headers.get("traceparent"),
  ).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(
    requests.find((r) => r.url.endsWith("/agent/api/sessions/ses_wild_77/pay"))?.headers.get("traceparent"),
  ).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const spans = memoryExporter.getFinishedSpans();
  const httpSpans = spans.filter((span) => span.kind === 2);
  const bodySpans = spans.filter((span) => span.name === "softprobe.http.body.capture");
  expect(httpSpans).toHaveLength(3);
  expect(bodySpans).toHaveLength(3);
  for (const httpSpan of httpSpans) {
    expect(httpSpan.name).toBe("POST");
  }
  const createHttp = httpSpans.find((span) =>
    String(span.attributes["url.full"]).endsWith("/agent/api/sessions"),
  );
  const messageHttp = httpSpans.find((span) =>
    String(span.attributes["url.full"]).endsWith("/agent/api/sessions/ses_wild_77/messages"),
  );
  const payHttp = httpSpans.find((span) =>
    String(span.attributes["url.full"]).endsWith("/agent/api/sessions/ses_wild_77/pay"),
  );
  expect(createHttp?.attributes["url.template"]).toBeUndefined();
  expect(messageHttp?.attributes["url.template"]).toBe("/agent/api/sessions/*/messages");
  expect(payHttp?.attributes["url.template"]).toBe("/agent/api/sessions/*/pay");
  for (const span of spans) {
    expect(span.attributes).toMatchObject({
      "session.id": "ses_wild_77",
      "sp.session.id": "ses_wild_77",
    });
    expect(String(span.attributes["url.full"] ?? "")).not.toContain("*");
    expect(String(span.attributes["url.full"] ?? "")).not.toContain("/agent/api/status");
  }
  const payBody = bodySpans.find((span) =>
    String(span.attributes["url.full"]).endsWith("/agent/api/sessions/ses_wild_77/pay"),
  );
  expect(payBody?.attributes["url.template"]).toBe("/agent/api/sessions/*/pay");
  expect(JSON.parse(String(payBody?.attributes["http.request.body.content"]))).toEqual({
    requestId: "req_1",
    paymentDetails: { cardNumber: "[REDACTED]", cvv: "[REDACTED]" },
  });
});

it("exports active-page OTLP protobuf batches with keepalive disabled and drains response bodies", async () => {
  const collectorCalls: Array<{
    url: string;
    headers: Headers;
    keepalive: boolean | undefined;
    byteLength: number;
    response: Response;
  }> = [];

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://collector.example.test/v1/traces") {
      const body = init?.body as Uint8Array | undefined;
      const response = new Response("", { status: 200 });
      collectorCalls.push({
        url,
        headers: new Headers(init?.headers),
        keepalive: init?.keepalive,
        byteLength: body?.byteLength ?? 0,
        response,
      });
      return response;
    }
    return new Response(JSON.stringify({ payload: "x".repeat(36_000) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });

  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    httpBodyCapture: {
      routes: [{ method: "POST", path: "/api/orders" }],
    },
  }, createWebSessionState("journey-keepalive"));
  runtime = browserRuntime;

  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(`${window.location.origin}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: i }),
    });
    await res.json();
    await browserRuntime.waitForIdle();
    await browserRuntime.forceFlush();
  }

  expect(collectorCalls).toHaveLength(2);
  for (const call of collectorCalls) {
    expect(call.headers.get("authorization")).toBe("Bearer agent-key");
    expect(call.headers.get("content-type")).toBe("application/x-protobuf");
    expect(call.keepalive).toBe(false);
    expect(call.byteLength).toBeGreaterThan(36_000);
    expect(call.response.bodyUsed).toBe(true);
  }
});

it("falls back to non-keepalive fetch when hidden-page keepalive quota throws TypeError", async () => {
  const keepaliveAttempts: Array<boolean | undefined> = [];

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://collector.example.test/v1/traces") {
      keepaliveAttempts.push(init?.keepalive);
      if (init?.keepalive) {
        throw new TypeError("Failed to fetch");
      }
      return new Response("", { status: 200 });
    }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });

  const browserRuntime = createBrowserRuntime({
    apiKey: "agent-key",
    otlpEndpoint: "https://collector.example.test/v1/traces",
    serviceName: "travel-ota-web",
    httpBodyCapture: {
      routes: [{ method: "POST", path: "/api/orders" }],
    },
  }, createWebSessionState("journey-hidden"));
  runtime = browserRuntime;

  const res = await fetch(`${window.location.origin}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: 1 }),
  });
  await res.json();
  await browserRuntime.waitForIdle();
  await expect(browserRuntime.forceFlush()).resolves.toBeUndefined();

  expect(keepaliveAttempts).toEqual([true, false]);
});
