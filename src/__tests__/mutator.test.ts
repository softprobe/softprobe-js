/**
 * Task 4.2 / 4.4 / 4.5: Auto-Instrumentation Mutator.
 * Asserts that wrapping getNodeAutoInstrumentations injects our responseHook for Postgres, Undici, Redis.
 * Design §5.3: unit tests use contract-shaped mocks and assert softprobe.* attributes.
 */
import { applyAutoInstrumentationMutator } from '../capture/mutator';
import { PG_INSTRUMENTATION_NAME } from '../capture/postgres';
import { UNDICI_INSTRUMENTATION_NAME } from '../capture/undici';
import { REDIS_INSTRUMENTATION_NAME } from '../capture/redis';

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

    it('responseHook sets softprobe.request.body and softprobe.response.body when present', () => {
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

      const mockResult = {
        request: { method: 'POST', url: 'https://api.example.com/echo', body: { foo: 'bar' } },
        response: { statusCode: 201, body: { id: '123', created: true } },
      };
      responseHook(mockSpan, mockResult);

      expect(attributes['softprobe.request.body']).toBe(JSON.stringify({ foo: 'bar' }));
      expect(attributes['softprobe.response.body']).toBe(
        JSON.stringify({ statusCode: 201, body: { id: '123', created: true } })
      );
    });
  });

  describe('Redis responseHook (Task 4.5)', () => {
    it('injects responseHook for @opentelemetry/instrumentation-redis-4 in returned config', () => {
      const redisEntry = { instrumentationName: REDIS_INSTRUMENTATION_NAME };
      const mockGetNodeAutoInstrumentations = jest.fn(() => [redisEntry]);

      const mockModule = {
        getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
      };

      applyAutoInstrumentationMutator(mockModule as any);

      const result = mockModule.getNodeAutoInstrumentations();

      const redisInstrumentation = result.find(
        (item: { instrumentationName?: string }) =>
          item.instrumentationName === REDIS_INSTRUMENTATION_NAME
      );
      expect(redisInstrumentation).toBeDefined();
      expect(typeof (redisInstrumentation as any).responseHook).toBe('function');
    });

    it('responseHook sets softprobe.protocol, identifier, request and response body when result has command/args/reply', () => {
      const attributes: Record<string, unknown> = {};
      const mockSpan = {
        setAttribute(key: string, value: unknown) {
          attributes[key] = value;
        },
      };
      const redisEntry = { instrumentationName: REDIS_INSTRUMENTATION_NAME };
      const mockGetNodeAutoInstrumentations = jest.fn(() => [redisEntry]);
      const mockModule = {
        getNodeAutoInstrumentations: mockGetNodeAutoInstrumentations,
      };

      applyAutoInstrumentationMutator(mockModule as any);
      const result = mockModule.getNodeAutoInstrumentations();
      const redisInstrumentation = result.find(
        (item: { instrumentationName?: string }) =>
          item.instrumentationName === REDIS_INSTRUMENTATION_NAME
      );
      const responseHook = (redisInstrumentation as any).responseHook as (
        span: unknown,
        cmdName: string,
        cmdArgs: string[],
        response: unknown
      ) => void;

      responseHook(mockSpan, 'GET', ['user:1:cache'], 'cached-value');

      expect(attributes['softprobe.protocol']).toBe('redis');
      expect(attributes['softprobe.identifier']).toBe('GET user:1:cache');
      expect(attributes['softprobe.request.body']).toBe(JSON.stringify(['user:1:cache']));
      expect(attributes['softprobe.response.body']).toBe(JSON.stringify('cached-value'));
    });
  });
});
