/**
 * Task 10.2: HTTP inbound capture record writing.
 * - 10.2.1: Write inbound request record (store.saveRecord with type=inbound, protocol=http).
 * - 10.2.2: Inbound record includes responsePayload (status/body); same record as request.
 */

import type { CassetteStore } from '../store/cassette-store';
import { writeInboundHttpRecord } from '../capture/http-inbound';

describe('HTTP inbound capture (Task 10.2)', () => {
  it('10.2.1 writes inbound request record (type=inbound, protocol=http)', () => {
    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;

    writeInboundHttpRecord(mockStore, {
      traceId: 'trace-1',
      spanId: 'span-1',
      method: 'POST',
      url: 'https://api.example.com/echo',
      requestBody: { foo: 'bar' },
    });

    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('inbound');
    expect(record.protocol).toBe('http');
    expect(record.version).toBe('4.1');
    expect(record.identifier).toBe('POST https://api.example.com/echo');
    expect(record.requestPayload).toEqual({ body: { foo: 'bar' } });
  });

  it('10.2.2 same record includes responsePayload (status and body)', () => {
    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;

    writeInboundHttpRecord(mockStore, {
      traceId: 'trace-2',
      spanId: 'span-2',
      method: 'GET',
      url: 'https://api.example.com/users/1',
      statusCode: 200,
      responseBody: { id: 1, name: 'alice' },
    });

    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('inbound');
    expect(record.protocol).toBe('http');
    expect(record.responsePayload).toBeDefined();
    expect((record.responsePayload as { statusCode?: number }).statusCode).toBe(200);
    expect((record.responsePayload as { body?: unknown }).body).toEqual({
      id: 1,
      name: 'alice',
    });
  });
});
