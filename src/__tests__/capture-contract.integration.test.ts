/**
 * Integration test: when the real @opentelemetry/auto-instrumentations-node is
 * available, apply our mutator and verify that (1) our responseHooks are attached
 * to the expected instrumentation entries, and (2) calling each hook with a
 * contract-shaped result sets the expected softprobe.* attributes.
 * Design §5.3: contract alignment validation.
 */

import { applyAutoInstrumentationMutator } from '../capture/mutator';
import { PG_INSTRUMENTATION_NAME } from '../capture/postgres';
import { UNDICI_INSTRUMENTATION_NAME } from '../capture/undici';
import { REDIS_INSTRUMENTATION_NAME } from '../capture/redis';

function loadAutoInstrumentations(): { getNodeAutoInstrumentations: (opts?: unknown) => unknown[] } | null {
  try {
    return require('@opentelemetry/auto-instrumentations-node');
  } catch {
    return null;
  }
}

const describeIfRealPackage = loadAutoInstrumentations() ? describe : describe.skip;

describeIfRealPackage('Capture contract alignment (real auto-instrumentations)', () => {
  let autoInstrumentations: ReturnType<typeof loadAutoInstrumentations>;

  beforeAll(() => {
    autoInstrumentations = loadAutoInstrumentations();
    if (autoInstrumentations) {
      applyAutoInstrumentationMutator(autoInstrumentations);
    }
  });

  it('attaches responseHooks to pg, undici, and redis entries when using real getNodeAutoInstrumentations', () => {
    if (!autoInstrumentations) return;
    const result = autoInstrumentations.getNodeAutoInstrumentations() as { instrumentationName?: string; responseHook?: unknown }[];
    expect(Array.isArray(result)).toBe(true);

    const pg = result.find((e) => e.instrumentationName === PG_INSTRUMENTATION_NAME);
    const undici = result.find((e) => e.instrumentationName === UNDICI_INSTRUMENTATION_NAME);
    const redis = result.find((e) => e.instrumentationName === REDIS_INSTRUMENTATION_NAME);

    expect(pg).toBeDefined();
    expect(typeof pg?.responseHook).toBe('function');
    expect(undici).toBeDefined();
    expect(typeof undici?.responseHook).toBe('function');
    expect(redis).toBeDefined();
    expect(typeof redis?.responseHook).toBe('function');
  });

  it('undici hook sets softprobe.* when called with contract-shaped result', () => {
    if (!autoInstrumentations) return;
    const result = autoInstrumentations.getNodeAutoInstrumentations() as { instrumentationName?: string; responseHook?: (s: unknown, r: unknown) => void }[];
    const undici = result.find((e) => e.instrumentationName === UNDICI_INSTRUMENTATION_NAME);
    expect(undici?.responseHook).toBeDefined();

    const attributes: Record<string, unknown> = {};
    const mockSpan = { setAttribute: (k: string, v: unknown) => { attributes[k] = v; } };
    const contractResult = {
      request: { method: 'GET', url: 'https://api.example.com/users' },
      response: { statusCode: 200, body: { id: 1 } },
    };
    undici!.responseHook!(mockSpan, contractResult);

    expect(attributes['softprobe.protocol']).toBe('http');
    expect(attributes['softprobe.identifier']).toBe('GET https://api.example.com/users');
    expect(attributes['softprobe.response.body']).toBe(JSON.stringify({ statusCode: 200, body: { id: 1 } }));
  });

  it('redis hook sets softprobe.* when called with contract-shaped args', () => {
    if (!autoInstrumentations) return;
    const result = autoInstrumentations.getNodeAutoInstrumentations() as { instrumentationName?: string; responseHook?: (...args: unknown[]) => void }[];
    const redis = result.find((e) => e.instrumentationName === REDIS_INSTRUMENTATION_NAME);
    expect(redis?.responseHook).toBeDefined();

    const attributes: Record<string, unknown> = {};
    const mockSpan = { setAttribute: (k: string, v: unknown) => { attributes[k] = v; } };
    redis!.responseHook!(mockSpan, 'GET', ['user:1:cache'], 'cached');

    expect(attributes['softprobe.protocol']).toBe('redis');
    expect(attributes['softprobe.identifier']).toBe('GET user:1:cache');
    expect(attributes['softprobe.request.body']).toBe(JSON.stringify(['user:1:cache']));
    expect(attributes['softprobe.response.body']).toBe(JSON.stringify('cached'));
  });
});
