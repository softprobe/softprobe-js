/**
 * Task 10.5.1: Redis capture — command result written to outbound record.
 * Test: record.responsePayload equals stub.
 */

import type { CassetteStore } from '../store/cassette-store';
import { setCaptureStore } from '../capture/store-accessor';
import { buildRedisResponseHook } from '../capture/redis';

afterEach(() => {
  setCaptureStore(undefined);
});

describe('Redis capture (Task 10.5)', () => {
  it('10.5.1 captures command result into outbound record (responsePayload equals stub)', () => {
    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;
    setCaptureStore(mockStore);

    const responseHook = buildRedisResponseHook();
    const stubResponse = { cached: true, id: 42 };
    const mockSpan = {
      spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1' }),
      parentSpanId: 'parent-1',
      name: 'redis.get',
      setAttribute: () => {},
    };

    responseHook(mockSpan, 'GET', ['user:1'], stubResponse);

    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('outbound');
    expect(record.protocol).toBe('redis');
    expect(record.identifier).toBe('GET user:1');
    expect(record.responsePayload).toEqual(stubResponse);
  });
});
