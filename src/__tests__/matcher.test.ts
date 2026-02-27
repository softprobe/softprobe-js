import { trace } from '@opentelemetry/api';
import { SemanticMatcher } from '../core/matcher/matcher';
import type { MatchRequest } from '../types/schema';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function mockSpan(protocol: string, identifier: string, responseBody: string): ReadableSpan {
  return {
    attributes: {
      'softprobe.protocol': protocol,
      'softprobe.identifier': identifier,
      'softprobe.response.body': responseBody,
    },
  } as unknown as ReadableSpan;
}

/** Builds a ReadableSpan with name, spanId, and optional parent for lineage tests. */
function mockSpanWithLineage(
  name: string,
  spanId: string,
  parentSpanId: string | undefined,
  attrs: { protocol: string; identifier: string; responseBody: string }
): ReadableSpan {
  return {
    name,
    parentSpanId,
    spanContext: () => ({ traceId: 'trace-1', spanId } as ReturnType<ReadableSpan['spanContext']>),
    attributes: {
      'softprobe.protocol': attrs.protocol,
      'softprobe.identifier': attrs.identifier,
      'softprobe.response.body': attrs.responseBody,
    },
  } as unknown as ReadableSpan;
}

describe('SemanticMatcher', () => {
  it('throws when no recorded spans match (empty or no match)', () => {
    const matcher = new SemanticMatcher([]);
    const request: MatchRequest = { protocol: 'postgres', identifier: 'SELECT 1' };

    expect(() => matcher.findMatch(request)).toThrow(
      '[Softprobe] No recorded traces found for postgres: SELECT 1'
    );
  });

  it('filters by protocol and identifier and returns parsed softprobe.response.body', () => {
    const span1 = mockSpan('postgres', 'SELECT 1', '{"rowCount":1}');
    const span2 = mockSpan('postgres', 'SELECT 2', '{"rowCount":2}');
    const matcher = new SemanticMatcher([span1, span2]);

    const result = matcher.findMatch({ protocol: 'postgres', identifier: 'SELECT 2' });

    expect(result).toEqual({ rowCount: 2 });
  });

  it('selects the correct child span by lineage when active OTel context matches parent name', () => {
    const parentA = mockSpanWithLineage('Service.getUser', 'parent-a', undefined, {
      protocol: 'http',
      identifier: '/users/1',
      responseBody: '{}',
    });
    const childA = mockSpanWithLineage('postgres.query', 'child-a', 'parent-a', {
      protocol: 'postgres',
      identifier: 'SELECT * FROM users WHERE id = $1',
      responseBody: '{"from":"A"}',
    });
    const parentB = mockSpanWithLineage('OtherHandler', 'parent-b', undefined, {
      protocol: 'http',
      identifier: '/other',
      responseBody: '{}',
    });
    const childB = mockSpanWithLineage('postgres.query', 'child-b', 'parent-b', {
      protocol: 'postgres',
      identifier: 'SELECT * FROM users WHERE id = $1',
      responseBody: '{"from":"B"}',
    });
    // Order so flat match would pick childB first; lineage must pick childA by parent name.
    const recordedSpans = [parentA, parentB, childB, childA];
    const matcher = new SemanticMatcher(recordedSpans);

    const getActiveSpan = jest
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue({ name: 'Service.getUser' } as unknown as ReturnType<typeof trace.getActiveSpan>);

    const result = matcher.findMatch({
      protocol: 'postgres',
      identifier: 'SELECT * FROM users WHERE id = $1',
    });

    expect(result).toEqual({ from: 'A' });
    getActiveSpan.mockRestore();
  });

  it('returns lineage-matched spans sequentially when multiple identical spans match (deduplication)', () => {
    const parent = mockSpanWithLineage('Service.getItems', 'parent-1', undefined, {
      protocol: 'http',
      identifier: '/items',
      responseBody: '{}',
    });
    const child1 = mockSpanWithLineage('postgres.query', 'child-1', 'parent-1', {
      protocol: 'postgres',
      identifier: 'SELECT * FROM items WHERE user_id = $1',
      responseBody: '{"seq":1}',
    });
    const child2 = mockSpanWithLineage('postgres.query', 'child-2', 'parent-1', {
      protocol: 'postgres',
      identifier: 'SELECT * FROM items WHERE user_id = $1',
      responseBody: '{"seq":2}',
    });
    const child3 = mockSpanWithLineage('postgres.query', 'child-3', 'parent-1', {
      protocol: 'postgres',
      identifier: 'SELECT * FROM items WHERE user_id = $1',
      responseBody: '{"seq":3}',
    });
    const recordedSpans = [parent, child1, child2, child3];
    const matcher = new SemanticMatcher(recordedSpans);

    const getActiveSpan = jest
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue({ name: 'Service.getItems' } as unknown as ReturnType<typeof trace.getActiveSpan>);

    const req: MatchRequest = {
      protocol: 'postgres',
      identifier: 'SELECT * FROM items WHERE user_id = $1',
    };

    expect(matcher.findMatch(req)).toEqual({ seq: 1 });
    expect(matcher.findMatch(req)).toEqual({ seq: 2 });
    expect(matcher.findMatch(req)).toEqual({ seq: 3 });

    getActiveSpan.mockRestore();
  });

  it('returns custom matcher MOCK payload when a custom matcher is registered (user override)', () => {
    const span = mockSpan('postgres', 'SELECT 1', '{"rowCount":1}');
    const matcher = new SemanticMatcher([span]);

    matcher.addMatcher((_liveRequest: MatchRequest, _recordedSpans: ReadableSpan[]) => ({
      action: 'MOCK',
      payload: 'override',
    }));

    const result = matcher.findMatch({ protocol: 'postgres', identifier: 'SELECT 1' });

    expect(result).toBe('override');
  });

  it('throws when a custom matcher returns PASSTHROUGH (strict mode)', () => {
    const span = mockSpan('postgres', 'SELECT 1', '{"rowCount":1}');
    const matcher = new SemanticMatcher([span]);

    matcher.addMatcher((_liveRequest: MatchRequest, _recordedSpans: ReadableSpan[]) => ({
      action: 'PASSTHROUGH',
    }));

    expect(() =>
      matcher.findMatch({ protocol: 'postgres', identifier: 'SELECT 1' })
    ).toThrow('[Softprobe] Network Passthrough not allowed in strict mode');
  });
});
