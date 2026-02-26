/**
 * Task 10.4.1: Postgres capture — query result rows written to outbound record.
 * Test: record.responsePayload.rows matches stub.
 */

import type { CassetteStore } from '../store/cassette-store';
import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { setCaptureStore } from '../capture/store-accessor';
import { SoftprobeContext } from '../context';
import type { Cassette } from '../types/schema';
import {
  buildPostgresResponseHook,
  type PgResultInfo,
} from '../capture/postgres';

afterEach(() => {
  setCaptureStore(undefined);
});

describe('Postgres capture (Task 10.4)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

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

  it('Task 6.5 outbound capture writes through context cassette helper with active trace id', async () => {
    const saveRecord = jest.fn(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    const responseHook = buildPostgresResponseHook();
    const stubResult: PgResultInfo = {
      data: { rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' },
    };
    const mockSpan = {
      spanContext: () => ({ traceId: 'span-trace-ignored', spanId: 'span-1' }),
      parentSpanId: 'parent-1',
      name: 'pg.query',
      attributes: {
        'softprobe.protocol': 'postgres',
        'softprobe.identifier': 'SELECT 1',
      },
      setAttribute: () => {},
    };

    await SoftprobeContext.run(
      { mode: 'CAPTURE', traceId: 'context-trace-postgres-6-5', storage: cassette },
      async () => {
        responseHook(mockSpan, stubResult);
        await Promise.resolve();
      }
    );

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord).toHaveBeenCalledWith(
      'context-trace-postgres-6-5',
      expect.objectContaining({ type: 'outbound', protocol: 'postgres' })
    );
  });
});
