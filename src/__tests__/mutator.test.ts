/**
 * Task 4.2 / 4.4: Auto-Instrumentation Mutator.
 * Asserts that wrapping getNodeAutoInstrumentations injects our responseHook for Postgres and HTTP/Undici.
 */
import { applyAutoInstrumentationMutator } from '../capture/mutator';

const PG_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-pg';
const UNDICI_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-undici';

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

  describe('HTTP/Undici responseHook (Task 4.4)', () => {
    it('injects responseHook for @opentelemetry/instrumentation-undici in returned config', () => {
      const undiciEntry = { instrumentationName: UNDICI_INSTRUMENTATION_NAME };
      const mockGetNodeAutoInstrumentations = jest.fn(() => [undiciEntry]);

      const mockModule = {
        getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
      };

      applyAutoInstrumentationMutator(mockModule as any);

      const result = mockModule.getNodeAutoInstrumentations();

      const undiciInstrumentation = result.find(
        (item: { instrumentationName?: string }) =>
          item.instrumentationName === UNDICI_INSTRUMENTATION_NAME
      );
      expect(undiciInstrumentation).toBeDefined();
      expect(typeof (undiciInstrumentation as any).responseHook).toBe(
        'function'
      );
    });

    it('responseHook sets softprobe.protocol and softprobe.identifier on span', () => {
      const attributes: Record<string, unknown> = {};
      const mockSpan = {
        setAttribute(key: string, value: unknown) {
          attributes[key] = value;
        },
      };
      const undiciEntry = { instrumentationName: UNDICI_INSTRUMENTATION_NAME };
      const mockGetNodeAutoInstrumentations = jest.fn(() => [undiciEntry]);
      const mockModule = {
        getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
      };

      applyAutoInstrumentationMutator(mockModule as any);
      const result = mockModule.getNodeAutoInstrumentations();
      const undiciInstrumentation = result.find(
        (item: { instrumentationName?: string }) =>
          item.instrumentationName === UNDICI_INSTRUMENTATION_NAME
      );
      const responseHook = (undiciInstrumentation as any).responseHook as (
        span: unknown,
        result: unknown
      ) => void;

      // Simulate what undici instrumentation might pass: span + result with request/response info
      const mockResult = {
        request: { method: 'GET', origin: 'https://api.example.com', path: '/users' },
        response: { statusCode: 200 },
      };
      responseHook(mockSpan, mockResult);

      expect(attributes['softprobe.protocol']).toBe('http');
      expect(attributes['softprobe.identifier']).toBe(
        'GET https://api.example.com/users'
      );
    });
  });
});
