/**
 * Task 4.2: Auto-Instrumentation Mutator.
 * Asserts that wrapping getNodeAutoInstrumentations injects our responseHook for Postgres.
 */
import { applyAutoInstrumentationMutator } from '../capture/mutator';

const PG_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-pg';

describe('applyAutoInstrumentationMutator', () => {
  it('injects custom responseHook for @opentelemetry/instrumentation-pg in returned config', () => {
    const pgEntry = { instrumentationName: PG_INSTRUMENTATION_NAME };
    const otherEntry = { instrumentationName: 'http' };
    const mockGetNodeAutoInstrumentations = jest.fn(() => [pgEntry, otherEntry]);

    const mockModule = {
      getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
    };

    applyAutoInstrumentationMutator(mockModule as any);

    const result = mockModule.getNodeAutoInstrumentations();

    expect(mockGetNodeAutoInstrumentations).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const pgInstrumentation = result.find(
      (item: { instrumentationName?: string }) =>
        item.instrumentationName === PG_INSTRUMENTATION_NAME
    );
    expect(pgInstrumentation).toBeDefined();
    expect(typeof (pgInstrumentation as any).responseHook).toBe('function');
  });
});
