import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

export type RetryingSpanExporterOptions = {
  /** Total attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Base delay before first retry (ms). Default 200. */
  baseDelayMs?: number;
  /** Cap for exponential backoff (ms). Default 2000. */
  maxDelayMs?: number;
  /**
   * Max wall time for all attempts (ms). Default 25000 — must stay under
   * BatchSpanProcessor `exportTimeoutMillis` (typically 30s).
   */
  budgetMs?: number;
};

/**
 * Wraps an OTLP exporter so transient timeouts/network failures retry instead
 * of silently dropping spans. Softprobe → thelake (Cloudflare) often needs
 * more than one shot under load.
 *
 * Retry budget must stay under the BatchSpanProcessor exportTimeout, otherwise
 * the processor abandons the batch while retries are still in flight.
 */
export class RetryingSpanExporter implements SpanExporter {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  /** Wall-clock budget for all attempts (ms). */
  private readonly budgetMs: number;

  constructor(
    private readonly inner: SpanExporter,
    options: RetryingSpanExporterOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseDelayMs = options.baseDelayMs ?? 200;
    this.maxDelayMs = options.maxDelayMs ?? 2000;
    this.budgetMs = options.budgetMs ?? 25_000;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const started = Date.now();
    const attempt = (n: number) => {
      this.inner.export(spans, (result) => {
        if (
          result.code === ExportResultCode.SUCCESS ||
          n + 1 >= this.maxAttempts ||
          Date.now() - started >= this.budgetMs
        ) {
          resultCallback(result);
          return;
        }
        const delay = Math.min(
          this.maxDelayMs,
          this.baseDelayMs * 2 ** n,
        );
        if (Date.now() - started + delay >= this.budgetMs) {
          resultCallback(result);
          return;
        }
        setTimeout(() => attempt(n + 1), delay);
      });
    };
    attempt(0);
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    if (typeof this.inner.forceFlush === "function") {
      await this.inner.forceFlush();
    }
  }
}
