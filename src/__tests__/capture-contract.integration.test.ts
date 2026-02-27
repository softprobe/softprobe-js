/**
 * Integration test: when the real @opentelemetry/auto-instrumentations-node is
 * available, apply our mutator and verify that (1) our responseHooks are attached
 * to the expected instrumentation entries, and (2) calling each hook with a
 * contract-shaped result sets the expected softprobe.* attributes.
 * Design §5.3: contract alignment validation.
 */

import { applyAutoInstrumentationMutator } from '../bootstrap/otel/mutator';
import { PG_INSTRUMENTATION_NAME } from '../instrumentations/postgres/capture';
import { REDIS_INSTRUMENTATION_NAME } from '../instrumentations/redis/capture';

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

  it('attaches responseHooks to pg and redis entries when using real getNodeAutoInstrumentations (HTTP via MSW only)', () => {
    if (!autoInstrumentations) return;
    const result = autoInstrumentations.getNodeAutoInstrumentations() as { instrumentationName?: string; responseHook?: unknown }[];
    expect(Array.isArray(result)).toBe(true);

    const pg = result.find((e) => e.instrumentationName === PG_INSTRUMENTATION_NAME);
    const redis = result.find((e) => e.instrumentationName === REDIS_INSTRUMENTATION_NAME);

    expect(pg).toBeDefined();
    expect(typeof pg?.responseHook).toBe('function');
    expect(redis).toBeDefined();
    expect(typeof redis?.responseHook).toBe('function');
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
