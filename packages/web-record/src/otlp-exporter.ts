import { context } from "@opentelemetry/api";
import { ExportResultCode, suppressTracing, type ExportResult } from "@opentelemetry/core";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

// Chromium enforces a cumulative 64 KiB cap across all active keepalive fetches in a renderer
// and retains that quota until response streams finish. Reserve keepalive strictly for small
// hidden-page unload flushes and fall back to standard fetch if the renderer quota is full.
const MAX_UNLOAD_KEEPALIVE_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 4_000;

export type BrowserOtlpExporterOptions = {
  url: string;
  apiKey: string;
  timeoutMillis?: number;
};

export class BrowserOtlpProtoSpanExporter implements SpanExporter {
  private readonly url: URL;
  private readonly apiKey: string;
  private readonly timeoutMillis: number;
  private readonly inflight = new Set<Promise<void>>();
  private stopped = false;

  constructor(options: BrowserOtlpExporterOptions) {
    this.url = new URL(options.url);
    this.apiKey = options.apiKey;
    this.timeoutMillis = options.timeoutMillis ?? DEFAULT_TIMEOUT_MS;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.stopped) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("OTLP trace exporter has been shut down"),
      });
      return;
    }
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    let serialized: Uint8Array | undefined;
    try {
      serialized = ProtobufTraceSerializer.serializeRequest(spans);
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    if (!serialized) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("Failed to serialize OTLP protobuf trace request"),
      });
      return;
    }

    const body = new Uint8Array(serialized);
    const task = context.with(suppressTracing(context.active()), () => this.sendWithRetry(body))
      .then((result) => {
        resultCallback(result);
      })
      .finally(() => {
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.forceFlush();
  }

  private async sendWithRetry(body: Uint8Array<ArrayBuffer>): Promise<ExportResult> {
    const deadline = Date.now() + this.timeoutMillis;
    let backoffMs = INITIAL_BACKOFF_MS;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          code: ExportResultCode.FAILED,
          error: new Error("OTLP trace export timed out"),
        };
      }

      const outcome = await this.sendOnce(body, remainingMs);
      if (outcome.status === "success") {
        return { code: ExportResultCode.SUCCESS };
      }
      if (outcome.status === "failure" || attempt === MAX_RETRIES) {
        return { code: ExportResultCode.FAILED, error: outcome.error };
      }

      const jittered = Math.min(backoffMs * (1 + Math.random() * 0.2), MAX_BACKOFF_MS);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      const waitMs = outcome.retryAfterMs ?? Math.round(jittered);
      if (Date.now() + waitMs >= deadline) {
        return { code: ExportResultCode.FAILED, error: outcome.error };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    return {
      code: ExportResultCode.FAILED,
      error: new Error("OTLP trace export exhausted retries"),
    };
  }

  private async sendOnce(
    body: Uint8Array<ArrayBuffer>,
    timeoutMs: number,
  ): Promise<
    | { status: "success" }
    | { status: "retryable"; error: Error; retryAfterMs?: number }
    | { status: "failure"; error: Error }
  > {
    const fetchApi = resolveUnwrappedFetch();
    const preferKeepalive = shouldUseUnloadKeepalive(body.byteLength);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.postPayload(fetchApi, body, abortController.signal, preferKeepalive);
      } catch (error) {
        if (preferKeepalive && error instanceof TypeError) {
          response = await this.postPayload(fetchApi, body, abortController.signal, false);
        } else {
          throw error;
        }
      }

      await response.arrayBuffer().catch(() => undefined);

      if (response.status >= 200 && response.status <= 299) {
        return { status: "success" };
      }
      if (isRetryableStatus(response.status)) {
        return {
          status: "retryable",
          error: new Error(`OTLP trace export returned retryable status ${response.status}`),
          retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
        };
      }
      return {
        status: "failure",
        error: new Error(`OTLP trace export failed with status ${response.status}`),
      };
    } catch (error) {
      if (error instanceof TypeError && !error.cause) {
        return {
          status: "retryable",
          error: new Error("Fetch request encountered a network error", { cause: error }),
        };
      }
      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private postPayload(
    fetchApi: typeof fetch,
    body: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
    keepalive: boolean,
  ): Promise<Response> {
    const mode: RequestMode =
      typeof globalThis.location !== "undefined"
        ? globalThis.location.origin === this.url.origin
          ? "same-origin"
          : "cors"
        : "cors";
    return fetchApi(this.url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal,
      keepalive,
      mode,
    });
  }
}

function resolveUnwrappedFetch(): typeof fetch {
  const candidate = globalThis.fetch as typeof fetch & { __original?: typeof fetch };
  const raw = typeof candidate.__original === "function" ? candidate.__original : candidate;
  return raw.bind(globalThis);
}

function shouldUseUnloadKeepalive(byteLength: number): boolean {
  return (
    byteLength <= MAX_UNLOAD_KEEPALIVE_BYTES &&
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isInteger(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const parsedDate = Date.parse(headerValue);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return undefined;
}
