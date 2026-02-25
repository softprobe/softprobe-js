/**
 * Task 5.2: HTTP Undici Replay.
 * Asserts fetch is intercepted, queries the SemanticMatcher with protocol 'http'
 * and identifier = method + URL, and returns the mocked response (no live network).
 */

import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { setupUndiciReplay } from '../replay/undici';
import { SoftprobeMatcher } from '../replay/softprobe-matcher';
import { runSoftprobeScope } from './helpers/run-softprobe-scope';

describe('HTTP Undici Replay (Task 5.2)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupUndiciReplay();
  });

  it('returns mocked response from SemanticMatcher and does not hit the network', async () => {
    const matcher = new SoftprobeMatcher();
    matcher.use((span) => {
      const identifier = (span as { attributes?: Record<string, unknown> } | undefined)?.attributes?.['softprobe.identifier'];
      if (identifier === 'GET https://example.com/') {
        return { action: 'MOCK', payload: { statusCode: 200, body: 'hello' } };
      }
      return { action: 'CONTINUE' };
    });
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const res = await fetch('https://example.com/');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello');
    });
  });

  it('throws when request is unmocked (no recorded span for identifier)', async () => {
    const matcher = new SoftprobeMatcher();
    matcher.use((span) => {
      const identifier = (span as { attributes?: Record<string, unknown> } | undefined)?.attributes?.['softprobe.identifier'];
      if (identifier === 'GET https://example.com/') {
        return { action: 'MOCK', payload: { statusCode: 200, body: 'ok' } };
      }
      return { action: 'CONTINUE' };
    });
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      await expect(fetch('https://other.example.com/')).rejects.toThrow(
        /fetch failed/
      );
    });
  });
});
