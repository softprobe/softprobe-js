/**
 * Task 10.5.1: Redis capture — command result written to outbound record.
 * Test: record.responsePayload equals stub.
 * Task 13.10: Use run-scoped storage instead of setCaptureStore.
 */

import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { buildRedisResponseHook } from '../capture/redis';
import { SoftprobeContext } from '../context';
import type { Cassette } from '../types/schema';

describe('Redis capture (Task 10.5)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  it('10.5.1 captures command result into outbound record (responsePayload equals stub)', () => {
    const saveRecord = jest.fn<Promise<void>, [import('../types/schema').SoftprobeCassetteRecord]>(async () => {});
    const mockCassette: Cassette = { loadTrace: async () => [], saveRecord };

    SoftprobeContext.run({ mode: 'CAPTURE', traceId: 'trace-1', storage: mockCassette }, () => {
      const responseHook = buildRedisResponseHook();
      const stubResponse = { cached: true, id: 42 };
      const mockSpan = {
        spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1' }),
        parentSpanId: 'parent-1',
        name: 'redis.get',
        setAttribute: () => {},
      };

      responseHook(mockSpan, 'GET', ['user:1'], stubResponse);
    });

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0]).toHaveLength(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('outbound');
    expect(record.protocol).toBe('redis');
    expect(record.identifier).toBe('GET user:1');
    expect(record.responsePayload).toEqual({ cached: true, id: 42 });
  });

  it('Task 6.5 outbound capture writes through context cassette helper with active trace id', async () => {
    const saveRecord = jest.fn(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    const responseHook = buildRedisResponseHook();
    const mockSpan = {
      spanContext: () => ({ traceId: 'span-trace-ignored', spanId: 'span-1' }),
      parentSpanId: 'parent-1',
      name: 'redis.get',
      setAttribute: () => {},
    };

    await SoftprobeContext.run(
      { mode: 'CAPTURE', traceId: 'context-trace-redis-6-5', storage: cassette },
      async () => {
        responseHook(mockSpan, 'GET', ['user:1'], 'alice');
        await Promise.resolve();
      }
    );

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0]).toHaveLength(1);
    expect(saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'context-trace-redis-6-5', type: 'outbound', protocol: 'redis' })
    );
  });
});
