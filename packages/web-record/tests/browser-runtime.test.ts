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
  expect(spans.filter((span) => span.kind === 2)).toHaveLength(1);
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
