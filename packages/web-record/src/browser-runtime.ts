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
import { createHttpBodyCaptureHooks } from "./http-body-capture.js";
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
  apiOrigins: string[];
  httpBodyCapture?: HttpBodyCaptureOptions;
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
  });
  const collectorUrl = new URL(options.otlpEndpoint);
  const exporter = exporterOverride ?? new OTLPTraceExporter({
    url: collectorUrl.toString(),
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });
  const trackedExporter = new TrackingSpanExporter(exporter);
  const batchProcessor = new BatchSpanProcessor({
    exporter: trackedExporter,
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
  const filter = createUrlFilter(options.apiOrigins, collectorUrl);
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
    hasPendingTelemetry: () => lifecycle.hasPendingSpans() || trackedExporter.hasActiveExports(),
    waitForIdle: () => lifecycle.waitForIdle(),
    forceFlush: async () => {
      let error: unknown;
      try {
        await batchProcessor.forceFlush();
      } catch (caught) {
        error = caught;
      }
      await trackedExporter.waitForIdle();
      const callbackError = trackedExporter.takeError();
      lifecycle.markFlushed();
      if (error) throw error;
      if (callbackError) throw callbackError;
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

class TrackingSpanExporter implements SpanExporter {
  private activeExports = 0;
  private readonly idleWaiters = new Set<() => void>();
  private exportError: Error | undefined;

  constructor(private readonly exporter: SpanExporter) {}

  export(
    spans: Parameters<SpanExporter["export"]>[0],
    resultCallback: Parameters<SpanExporter["export"]>[1],
  ): void {
    this.activeExports += 1;
    try {
      this.exporter.export(spans, (result) => {
        if (result.code !== 0) {
          this.exportError ??= result.error ?? new Error("OpenTelemetry span export failed");
        }
        this.activeExports -= 1;
        if (this.activeExports === 0) {
          for (const resolve of this.idleWaiters) resolve();
          this.idleWaiters.clear();
        }
        resultCallback(result);
      });
    } catch (error) {
      this.activeExports -= 1;
      if (this.activeExports === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
      throw error;
    }
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  takeError(): Error | undefined {
    const error = this.exportError;
    this.exportError = undefined;
    return error;
  }

  hasActiveExports(): boolean {
    return this.activeExports > 0;
  }

  waitForIdle(): Promise<void> {
    if (this.activeExports === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
}

function createUrlFilter(apiOrigins: string[], collectorUrl: URL): {
  ignoreUrls: RegExp[];
  propagateUrls: RegExp[];
} {
  const origins = normalizeOrigins(apiOrigins);
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

function normalizeOrigins(origins: string[]): string[] {
  const normalized = new Set<string>();
  for (const candidate of origins) {
    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      ) {
        normalized.add(url.origin);
      }
    } catch {
      // Invalid origins never widen instrumentation or propagation.
    }
  }
  return [...normalized];
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

