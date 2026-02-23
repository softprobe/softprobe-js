/**
 * Task 10.4.1: Postgres capture — query result rows written to outbound record.
 * Test: record.responsePayload.rows matches stub.
 */

import type { CassetteStore } from '../store/cassette-store';
import { setCaptureStore } from '../capture/store-accessor';
import {
  buildPostgresResponseHook,
  type PgResultInfo,
} from '../capture/postgres';

afterEach(() => {
  setCaptureStore(undefined);
});

describe('Postgres capture (Task 10.4)', () => {
  it('10.4.1 capture writes query result rows into outbound record (responsePayload.rows matches stub)', () => {
    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;
    setCaptureStore(mockStore);

    const responseHook = buildPostgresResponseHook();
    const stubRows = [{ id: 1, name: 'alice' }];
    const stubResult: PgResultInfo = {
      data: { rows: stubRows, rowCount: 1, command: 'SELECT' },
    };
    const mockSpan = {
      spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1' }),
      parentSpanId: 'parent-1',
      name: 'pg.query',
      attributes: {
        'softprobe.protocol': 'postgres',
        'softprobe.identifier': 'SELECT * FROM users',
      },
      setAttribute: () => {},
    };

    responseHook(mockSpan, stubResult);

    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.version).toBe('4.1');
    expect(record.type).toBe('outbound');
    expect(record.protocol).toBe('postgres');
    expect(record.identifier).toBe('SELECT * FROM users');
    expect(record.responsePayload).toBeDefined();
    expect((record.responsePayload as { rows?: unknown[] }).rows).toEqual(stubRows);
  });
});
