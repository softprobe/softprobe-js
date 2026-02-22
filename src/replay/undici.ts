/**
 * HTTP/Undici replay: intercepts fetch so that under replay context requests
 * are resolved by the SemanticMatcher (no live network). Pairs with capture
 * Task 4.4; identifier = method + URL per design §3.1, §6.2.
 */

import shimmer from 'shimmer';
import { softprobe } from '../api';

/** Recorded HTTP response shape from capture (softprobe.response.body). */
interface RecordedHttpResponse {
  statusCode?: number;
  body?: unknown;
}

/**
 * Sets up HTTP/Undici replay by wrapping undici fetch. When replay context
 * has a matcher, requests are intercepted and return the recorded status and
 * body from the matcher. If no matcher or no match, throws per AC4 (unmocked request).
 */
export function setupUndiciReplay(): void {
  const undici = require('undici') as { fetch: typeof fetch };
  shimmer.wrap(undici, 'fetch', (originalFetch: (...args: unknown[]) => unknown) => {
    const original = originalFetch as typeof fetch;
    return function wrappedFetch(...args: unknown[]): unknown {
      const input = args[0] as string | URL | Request;
      const init = args[1] as RequestInit | undefined;
      const matcher = softprobe.getActiveMatcher();
      if (!matcher) {
        return original(input, init);
      }

      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const identifier = `${method} ${url}`;

      let payload: RecordedHttpResponse;
      try {
        payload = matcher.findMatch({
          protocol: 'http',
          identifier,
          requestBody: init?.body,
        }) as RecordedHttpResponse;
      } catch (err) {
        return Promise.reject(err);
      }

      const status = payload.statusCode ?? 200;
      const body = payload.body;
      const bodyStr =
        body === undefined || body === null
          ? ''
          : typeof body === 'string'
            ? body
            : JSON.stringify(body);

      return Promise.resolve(new Response(bodyStr, { status }));
    };
  });
  // Node's global fetch may be a different reference; ensure it uses our wrapper.
  if (typeof globalThis.fetch !== 'undefined') {
    globalThis.fetch = undici.fetch as typeof fetch;
  }
}
