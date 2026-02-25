/**
 * Task 5.2: HTTP Undici Replay.
 * Asserts fetch is intercepted, queries the SemanticMatcher with protocol 'http'
 * and identifier = method + URL, and returns the mocked response (no live network).
 */

import * as otelApi from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { SemanticMatcher } from '../replay/matcher';
import { softprobe } from '../api';
import { setupUndiciReplay } from '../replay/undici';

function mockHttpSpan(identifier: string, responseBody: { statusCode?: number; body?: unknown }): ReadableSpan {
  return {
    attributes: {
      'softprobe.protocol': 'http',
      'softprobe.identifier': identifier,
      'softprobe.response.body': JSON.stringify(responseBody),
    },
  } as unknown as ReadableSpan;
}

describe('HTTP Undici Replay (Task 5.2)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupUndiciReplay();
  });

  it('returns mocked response from SemanticMatcher and does not hit the network', async () => {
    const matcher = new SemanticMatcher([
      mockHttpSpan('GET https://example.com/', { statusCode: 200, body: 'hello' }),
    ]);
    await softprobe.runWithContext({ traceId: 't1', matcher }, async () => {
      const res = await fetch('https://example.com/');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello');
    });
  });

  it('throws when request is unmocked (no recorded span for identifier)', async () => {
    const matcher = new SemanticMatcher([
      mockHttpSpan('GET https://example.com/', { statusCode: 200, body: 'ok' }),
    ]);
    await softprobe.runWithContext({ traceId: 't1', matcher }, async () => {
      await expect(fetch('https://other.example.com/')).rejects.toThrow(
        /\[Softprobe\] No recorded traces found for http: GET https:\/\/other\.example\.com\//
      );
    });
  });
});
