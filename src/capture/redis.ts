/**
 * Capture hook for Redis. Pairs with replay/redis.ts (same protocol & identifier).
 * Design §3.1, §5.3: responseHook contract must match @opentelemetry/instrumentation-redis-4.
 *
 * Actual contract (from types.d.ts):
 *   responseHook(span: Span, cmdName: string, cmdArgs: Array<string|Buffer>, response: unknown): void
 */

export const REDIS_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-redis-4';

/**
 * Builds the responseHook for Redis instrumentation.
 * Sets softprobe.protocol: 'redis', identifier (command + key/args), and
 * request/response on spans per design §3.1.
 *
 * The instrumentation calls: responseHook(span, cmdName, cmdArgs, response).
 * We declare the return type loosely so it can be stored via injectHook.
 */
export function buildRedisResponseHook(): (...args: unknown[]) => void {
  return (span: unknown, cmdName: unknown, cmdArgs: unknown, response: unknown) => {
    const s = span as { setAttribute: (key: string, value: unknown) => void };
    const cmd = (cmdName != null ? String(cmdName) : 'UNKNOWN').toUpperCase();
    const args = Array.isArray(cmdArgs) ? cmdArgs : [];
    const identifier = [cmd, ...args.map((a) => (a != null ? String(a) : ''))].join(' ').trim();

    s.setAttribute('softprobe.protocol', 'redis');
    s.setAttribute('softprobe.identifier', identifier);
    if (args.length > 0) {
      s.setAttribute('softprobe.request.body', JSON.stringify(args));
    }
    if (typeof response !== 'undefined') {
      s.setAttribute('softprobe.response.body', JSON.stringify(response));
    }
  };
}
