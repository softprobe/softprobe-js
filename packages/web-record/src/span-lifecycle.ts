import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";

/** Tracks in-flight spans so flush can wait before draining the OTel batch queue. */
export class SpanLifecycleProcessor implements SpanProcessor {
  private readonly active = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private endedSinceFlush = 0;

  onStart(span: Span, _parentContext: Context): void {
    this.active.add(spanKey(span.spanContext().traceId, span.spanContext().spanId));
  }

  onEnd(span: ReadableSpan): void {
    this.active.delete(spanKey(span.spanContext().traceId, span.spanContext().spanId));
    this.endedSinceFlush += 1;
    if (this.active.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
    return Promise.resolve();
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  hasPendingSpans(): boolean {
    return this.active.size > 0 || this.endedSinceFlush > 0;
  }

  markFlushed(): void {
    this.endedSinceFlush = 0;
  }
}

function spanKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`;
}
