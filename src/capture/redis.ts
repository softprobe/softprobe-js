/**
 * Capture hook for Redis. Pairs with replay/redis.ts (same protocol & identifier).
 * Design §3.1, §5.3: responseHook contract must match @opentelemetry/instrumentation-redis-4.
 */

/** Result shape passed to Redis instrumentation responseHook(span, result). Contract: align with real package. */
export interface RedisResultLike {
  command?: string;
  args?: unknown[];
  reply?: unknown;
}

export const REDIS_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-redis-4';

/**
 * Builds the responseHook for Redis instrumentation.
 * Sets softprobe.protocol: 'redis', identifier (command + key/args), and
 * request/response on spans per design §3.1.
 * Signature (span: unknown, result: unknown) for compatibility with injectResponseHook.
 */
export function buildRedisResponseHook(): (span: unknown, result: unknown) => void {
  return (span, result) => {
    const s = span as { setAttribute: (key: string, value: unknown) => void };
    const res = result as RedisResultLike;
    const cmd = (res?.command ?? 'unknown').toString().toUpperCase();
    const args = Array.isArray(res?.args) ? res.args : [];
    const identifier = [cmd, ...args.map((a) => (a != null ? String(a) : ''))].join(' ').trim();

    s.setAttribute('softprobe.protocol', 'redis');
    s.setAttribute('softprobe.identifier', identifier);
    if (res?.args != null) {
      s.setAttribute('softprobe.request.body', JSON.stringify(res.args));
    }
    if (typeof res?.reply !== 'undefined') {
      s.setAttribute('softprobe.response.body', JSON.stringify(res.reply));
    }
  };
}
