import {
  SoftprobeAttributes,
  MatchRequest,
  Protocol,
  SoftprobeCassetteRecord,
  SoftprobeCassette,
} from '../types/schema';

describe('schema', () => {
  it('exports SoftprobeAttributes with required protocol and identifier', () => {
    const attrs: SoftprobeAttributes = {
      'softprobe.protocol': 'postgres',
      'softprobe.identifier': 'SELECT 1',
    };
    expect(attrs['softprobe.protocol']).toBe('postgres');
    expect(attrs['softprobe.identifier']).toBe('SELECT 1');
  });

  it('exports MatchRequest with protocol, identifier, optional requestBody', () => {
    const req: MatchRequest = { protocol: 'redis', identifier: 'get' };
    expect(req.protocol).toBe('redis');
    expect(req.identifier).toBe('get');
  });

  it('exports Protocol as union of http | postgres | redis | amqp', () => {
    const p: Protocol = 'postgres';
    expect(p).toBe('postgres');
  });

  it('exports SoftprobeCassetteRecord with version 4.1, traceId, spanId, type, protocol, identifier', () => {
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't1',
      spanId: 's1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'outbound',
      protocol: 'postgres',
      identifier: 'SELECT 1',
      responsePayload: [],
    };
    expect(record.version).toBe('4.1');
    expect(record.traceId).toBe('t1');
    expect(record.spanId).toBe('s1');
    expect(record.type).toBe('outbound');
    expect(record.protocol).toBe('postgres');
    expect(record.identifier).toBe('SELECT 1');
    expect(record.responsePayload).toEqual([]);
  });

  it('SoftprobeCassetteRecord allows optional requestPayload, spanName, parentSpanId', () => {
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't1',
      spanId: 's1',
      spanName: 'pg.query',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'outbound',
      protocol: 'postgres',
      identifier: 'SELECT 1',
      requestPayload: { query: 'SELECT 1', values: [] },
      responsePayload: [{ id: 1 }],
    };
    expect(record.requestPayload).toEqual({ query: 'SELECT 1', values: [] });
    expect(record.responsePayload).toEqual([{ id: 1 }]);
    expect(record.spanName).toBe('pg.query');
  });

  it('exports SoftprobeCassette with version 3.0 and records array', () => {
    const cassette: SoftprobeCassette = {
      version: '3.0',
      records: [],
    };
    expect(cassette.version).toBe('3.0');
    expect(cassette.records).toEqual([]);
  });

  it('SoftprobeCassette records are typed as SoftprobeCassetteRecord[]', () => {
    const cassette: SoftprobeCassette = {
      version: '3.0',
      records: [
        {
          version: '4.1',
          traceId: 't1',
          spanId: 's1',
          timestamp: '2025-01-01T00:00:00.000Z',
          type: 'outbound',
          protocol: 'postgres',
          identifier: 'SELECT 1',
          responsePayload: [],
        },
      ],
    };
    expect(cassette.records).toHaveLength(1);
    expect(cassette.records[0].version).toBe('4.1');
    expect(cassette.records[0].spanName).toBeUndefined();
    expect(cassette.records[0].protocol).toBe('postgres');
  });
});
