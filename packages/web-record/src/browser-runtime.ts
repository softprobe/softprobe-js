import { trace } from "@opentelemetry/api";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { createSessionSpanProcessor, type SessionProvider } from "@opentelemetry/browser-sdk/session";
import { startTracesSdk } from "@opentelemetry/browser-sdk/traces";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { HttpBodyCaptureOptions } from "./types.js";
import { createHttpBodyCaptureHooks, resolveEffectiveOrigins } from "./http-body-capture.js";
import type { WebSessionState } from "./session-state.js";
import { SpanLifecycleProcessor } from "./span-lifecycle.js";

const SCOPE_NAME = "softprobe.web.record";
const SCOPE_VERSION = "0.1.0";
const SOFTPROBE_SESSION_ID = "sp.session.id";

export type BrowserRuntimeOptions = {
  apiKey: string;
  otlpEndpoint: string;
  serviceName?: string;
  environment?: string;
  apiOrigins?: string[];
  httpBodyCapture?: boolean | HttpBodyCaptureOptions;
  onSessionId?: (sessionId: string) => void;
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
 * instrumentations. OTel owns HTTP spans, context propagation, batching,
 * OTLP encoding, and export.
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
    onSessionId: options.onSessionId,
  });
  const collectorUrl = new URL(options.otlpEndpoint);
  const exporter = exporterOverride ?? new OTLPTraceExporter({
    url: collectorUrl.toString(),
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });
  const batchProcessor = new BatchSpanProcessor({
    exporter,
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 30000,
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
  });
  const processors: SpanProcessor[] = [
    sessionProcessor,
    softprobeSessionProcessor,
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

function createUrlFilter(origins: string[], collectorUrl: URL): {
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
