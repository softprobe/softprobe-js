/**
 * Capture hook for Redis. Pairs with replay/redis.ts (same protocol & identifier).
 * Design §3.1, §5.3: responseHook contract must match @opentelemetry/instrumentation-redis-4.
 * Design §10.5: when capture store is set, writes outbound record with responsePayload.
 *
 * Actual contract (from types.d.ts):
 *   responseHook(span: Span, cmdName: string, cmdArgs: Array<string|Buffer>, response: unknown): void
 */

import type { SoftprobeCassetteRecord } from '../types/schema';
import { redisIdentifier } from '../identifier';
import { getCaptureStore } from './store-accessor';

export const REDIS_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-redis-4';

/** Span-like shape for responseHook (context + setAttribute). */
interface SpanLike {
  spanContext?: () => { traceId: string; spanId: string };
  parentSpanId?: string;
  name?: string;
  setAttribute?: (key: string, value: unknown) => void;
}

/**
 * Builds the responseHook for Redis instrumentation.
 * Sets softprobe.protocol: 'redis', identifier (command + args), and
 * request/response on spans per design §3.1.
 * When a capture store is set, writes an outbound SoftprobeCassetteRecord (Task 10.5.1).
 *
 * The instrumentation calls: responseHook(span, cmdName, cmdArgs, response).
 * We declare the return type loosely so it can be stored via injectHook.
 */
export function buildRedisResponseHook(): (...args: unknown[]) => void {
  return (span: unknown, cmdName: unknown, cmdArgs: unknown, response: unknown) => {
    const s = span as SpanLike & { setAttribute: (key: string, value: unknown) => void };
    const cmd = (cmdName != null ? String(cmdName) : 'UNKNOWN').toUpperCase();
    const args = Array.isArray(cmdArgs)
      ? (cmdArgs as (string | Buffer)[]).map((a) => (a != null ? String(a) : ''))
      : [];
    const identifier = redisIdentifier(cmd, args);

    s.setAttribute?.('softprobe.protocol', 'redis');
    s.setAttribute?.('softprobe.identifier', identifier);
    if (args.length > 0) {
      s.setAttribute?.('softprobe.request.body', JSON.stringify(args));
    }
    if (typeof response !== 'undefined') {
      s.setAttribute?.('softprobe.response.body', JSON.stringify(response));
    }

    const store = getCaptureStore();
    if (!store) return;

    const ctx = s.spanContext?.() ?? { traceId: '', spanId: '' };
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: s.parentSpanId,
      spanName: s.name,
      timestamp: new Date().toISOString(),
      type: 'outbound',
      protocol: 'redis',
      identifier,
      responsePayload: response,
    };
    store.saveRecord(record);
  };
}
