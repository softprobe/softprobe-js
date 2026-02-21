import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  SoftprobeAttributes,
  SoftprobeTraceStore,
  MatchRequest,
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

  it('exports SoftprobeTraceStore as Record<string, ReadableSpan[]>', () => {
    const store: SoftprobeTraceStore = {};
    expect(store).toEqual({});
  });

  it('SoftprobeTraceStore values are typed as ReadableSpan[]', () => {
    const minimalSpan = {
      name: 'pg.query',
      parentSpanId: undefined as string | undefined,
      spanContext: () => ({ traceId: 't1', spanId: 's1' }),
      attributes: {
        'softprobe.protocol': 'postgres',
        'softprobe.identifier': 'SELECT 1',
        'softprobe.response.body': '[]',
      },
    } as unknown as ReadableSpan;
    const store: SoftprobeTraceStore = { 'trace-1': [minimalSpan] };
    expect(store['trace-1']).toHaveLength(1);
    expect(store['trace-1'][0].name).toBe('pg.query');
    expect(store['trace-1'][0].attributes['softprobe.protocol']).toBe('postgres');
  });
});
