import { SpanKind, trace } from "@opentelemetry/api";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { createSessionSpanProcessor, type SessionProvider } from "@opentelemetry/browser-sdk/session";
import { startTracesSdk } from "@opentelemetry/browser-sdk/traces";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { CausedHttpTrace, HttpBodyCaptureOptions } from "./types.js";
import type { ResourceAttributes } from "@softprobe/tracing";
import {
  createHttpBodyCaptureHooks,
  resolveEffectiveOrigins,
} from "./http-body-capture.js";
import { BrowserOtlpProtoSpanExporter } from "./otlp-exporter.js";
import type { WebSessionState } from "./session-state.js";
import { SpanLifecycleProcessor } from "./span-lifecycle.js";

const SCOPE_NAME = "softprobe.web.record";
const SCOPE_VERSION = "0.1.0";
const SOFTPROBE_SESSION_ID = "sp.session.id";

export type BrowserRuntimeOptions = {
  ingestionKey?: string;
  otlpEndpoint: string;
  otlpHeaders?: Record<string, string>;
  resourceAttributes?: ResourceAttributes;
  serviceName?: string;
  environment?: string;
  apiOrigins?: string[];
  httpBodyCapture?: boolean | HttpBodyCaptureOptions;
  onSessionId?: (sessionId: string) => void;
  onHttpSpanStart?: (info: {
    readonly traceId: string;
    readonly spanId: string;
    readonly method?: string;
    readonly url?: string;
    readonly urlTemplate?: string;
  }) => void;
  onHttpSpan?: (info: CausedHttpTrace) => void;
};

export type BrowserRuntime = {
  tracer: ReturnType<typeof trace.getTracer>;
  hasPendingTelemetry: () => boolean;
  waitForIdle: () => Promise<void>;
  forceFlush: () => Promise<void>;
  setSessionId: (sessionId: string) => void;
  shutdown: () => Promise<void>;
};

/**
 * Starts the official browser trace SDK and its official Fetch/XHR
 * instrumentations. OTel owns HTTP spans, context propagation, batching, and
 * OTLP protobuf encoding; BrowserOtlpProtoSpanExporter owns HTTP export.
 */
export function createBrowserRuntime(
  options: BrowserRuntimeOptions,
  sessionState: WebSessionState,
  exporterOverride?: SpanExporter,
): BrowserRuntime {
  const lifecycle = new SpanLifecycleProcessor();
  const sessionProcessor = createSessionSpanProcessor(sessionState);
  const softprobeSessionProcessor = new SoftprobeSessionAttributeProcessor(sessionState);
  const bodyHooks = createHttpBodyCaptureHooks({
    apiOrigins: options.apiOrigins,
    httpBodyCapture: options.httpBodyCapture,
    collectorUrl: options.otlpEndpoint,
    getTracer: () => trace.getTracer(SCOPE_NAME, SCOPE_VERSION),
    getSessionId: () => sessionState.getSessionId(),
    onSessionId: options.onSessionId,
  });
  const collectorUrl = new URL(options.otlpEndpoint);
  const exporter = exporterOverride ?? new BrowserOtlpProtoSpanExporter({
    url: collectorUrl.toString(),
    ingestionKey: options.ingestionKey ?? "",
    headers: options.otlpHeaders,
  });
  const batchProcessor = new BatchSpanProcessor({
    exporter,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 30000,
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
  });
  const processors: SpanProcessor[] = [
    sessionProcessor,
    softprobeSessionProcessor,
    ...(options.onHttpSpanStart || options.onHttpSpan
      ? [new HttpSpanObserverProcessor(options.onHttpSpanStart, options.onHttpSpan)]
      : []),
    lifecycle,
    batchProcessor,
  ];
  const filter = createUrlFilter(
    resolveEffectiveOrigins(options.apiOrigins, options.httpBodyCapture),
    collectorUrl,
  );
  const sdk = startTracesSdk({
    serviceName: options.serviceName,
    resourceAttributes: {
      ...(options.environment
        ? { "deployment.environment.name": options.environment }
        : {}),
      ...(options.resourceAttributes ?? {}),
    },
    processors,
    instrumentations: [
      new FetchInstrumentation({
        ignoreUrls: filter.ignoreUrls,
        propagateTraceHeaderCorsUrls: filter.propagateUrls,
        sanitizeUrl: sanitizeUrl,
        requestHook: bodyHooks.fetch.requestHook,
        applyCustomAttributesOnSpan: bodyHooks.fetch.applyCustomAttributesOnSpan,
      }),
      new XhrInstrumentation({
        ignoreUrls: filter.ignoreUrls,
        propagateTraceHeaderCorsUrls: filter.propagateUrls,
        sanitizeUrl: sanitizeUrl,
        applyCustomAttributesOnSpan: bodyHooks.xhr.applyCustomAttributesOnSpan,
      }),
    ],
  });

  if (sdk.invalidConfig) {
    throw new Error("[@softprobe/web-record] OpenTelemetry rejected its trace configuration.");
  }
  bodyHooks.fetch.installObserver();

  const runtime: BrowserRuntime = {
    tracer: trace.getTracer(SCOPE_NAME, SCOPE_VERSION),
    hasPendingTelemetry: () => lifecycle.hasPendingSpans(),
    waitForIdle: () => lifecycle.waitForIdle(),
    forceFlush: async () => {
      try {
        await batchProcessor.forceFlush();
      } finally {
        lifecycle.markFlushed();
      }
    },
    setSessionId: (sessionId) => sessionState.setSessionId(sessionId),
    shutdown: async () => {
      bodyHooks.dispose();
      await sdk.shutdown();
    },
  };
  return runtime;
}

class SoftprobeSessionAttributeProcessor implements SpanProcessor {
  constructor(private readonly sessionProvider: SessionProvider) {}

  onStart(span: Span): void {
    const sessionId = this.sessionProvider.getSessionId();
    if (sessionId) span.setAttribute(SOFTPROBE_SESSION_ID, sessionId);
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class HttpSpanObserverProcessor implements SpanProcessor {
  constructor(
    private readonly onHttpSpanStart?: (info: {
      readonly traceId: string;
      readonly spanId: string;
      readonly method?: string;
      readonly url?: string;
      readonly urlTemplate?: string;
    }) => void,
    private readonly onHttpSpan?: (info: CausedHttpTrace) => void,
  ) {}

  onStart(span: Span): void {
    if (span.kind !== SpanKind.CLIENT) return;
    const ctx = span.spanContext();
    let url: string | undefined;
    let method: string | undefined;
    let urlTemplate: string | undefined;
    if ("attributes" in span && isRecordObject(span.attributes)) {
      const rawUrl = String(span.attributes["url.full"] ?? span.attributes["http.url"] ?? "").trim();
      if (rawUrl) url = rawUrl;
      const rawName = "name" in span && typeof span.name === "string" ? span.name : "";
      const rawMethod = String(
        span.attributes["http.request.method"] ?? span.attributes["http.method"] ?? rawName,
      )
        .trim()
        .toUpperCase();
      if (rawMethod) method = rawMethod;
      const rawTpl = span.attributes["url.template"];
      if (typeof rawTpl === "string" && rawTpl.length > 0) urlTemplate = rawTpl;
    }
    this.onHttpSpanStart?.({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      ...(method !== undefined ? { method } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(urlTemplate !== undefined ? { urlTemplate } : {}),
    });
  }

  onEnd(span: ReadableSpan): void {
    if (span.kind !== SpanKind.CLIENT) return;
    const url = String(span.attributes["url.full"] ?? span.attributes["http.url"] ?? "").trim();
    if (!url) return;
    const method = String(
      span.attributes["http.request.method"] ??
        span.attributes["http.method"] ??
        span.name ??
        "GET",
    )
      .trim()
      .toUpperCase();
    const rawTemplate = span.attributes["url.template"];
    const urlTemplate = typeof rawTemplate === "string" && rawTemplate.length > 0 ? rawTemplate : undefined;
    const rawStatus = span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"];
    const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;
    const ctx = span.spanContext();
    this.onHttpSpan?.({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      method,
      url,
      ...(urlTemplate !== undefined ? { urlTemplate } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function createUrlFilter(
  origins: string[],
  collectorUrl: URL,
): {
  ignoreUrls: RegExp[];
  propagateUrls: RegExp[];
} {
  const allowlistPattern = origins.map(escapeRegExp).join("|");
  const ignoreUnselected = origins.length
    ? new RegExp(`^(?!(?:${allowlistPattern})(?:[/?#]|$))`)
    : /^/;
  const collectorPath = collectorUrl.pathname.replace(/\/+$/, "") || "/";
  const ignoreCollector = new RegExp(
    `^${escapeRegExp(collectorUrl.origin + collectorPath)}(?:[?#]|$)`,
  );
  return {
    ignoreUrls: [ignoreUnselected, ignoreCollector],
    propagateUrls: origins.map((origin) =>
      new RegExp(`^${escapeRegExp(origin)}(?:[/?#]|$)`),
    ),
  };
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, typeof location === "undefined" ? undefined : location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
