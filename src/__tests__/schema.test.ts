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

  it('exports SoftprobeCassetteRecord with traceId, spanId, name, protocol, identifier, responsePayload', () => {
    const record: SoftprobeCassetteRecord = {
      traceId: 't1',
      spanId: 's1',
      parentSpanId: undefined,
      name: 'pg.query',
      protocol: 'postgres',
      identifier: 'SELECT 1',
      responsePayload: [],
    };
    expect(record.traceId).toBe('t1');
    expect(record.spanId).toBe('s1');
    expect(record.name).toBe('pg.query');
    expect(record.protocol).toBe('postgres');
    expect(record.identifier).toBe('SELECT 1');
    expect(record.responsePayload).toEqual([]);
  });

  it('SoftprobeCassetteRecord allows optional requestPayload', () => {
    const record: SoftprobeCassetteRecord = {
      traceId: 't1',
      spanId: 's1',
      name: 'pg.query',
      protocol: 'postgres',
      identifier: 'SELECT 1',
      requestPayload: { query: 'SELECT 1', values: [] },
      responsePayload: [{ id: 1 }],
    };
    expect(record.requestPayload).toEqual({ query: 'SELECT 1', values: [] });
    expect(record.responsePayload).toEqual([{ id: 1 }]);
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
          traceId: 't1',
          spanId: 's1',
          name: 'pg.query',
          protocol: 'postgres',
          identifier: 'SELECT 1',
          responsePayload: [],
        },
      ],
    };
    expect(cassette.records).toHaveLength(1);
    expect(cassette.records[0].name).toBe('pg.query');
    expect(cassette.records[0].protocol).toBe('postgres');
  });
});
