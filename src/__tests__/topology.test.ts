/**
 * Task 5.1.1: Define how to read live parent name (stub).
 * Task 5.2.1: Build bySpanId index from records; recorded parent lookup works.
 * Task 5.3.1: Filter candidates by protocol+identifier; same as flat filter.
 * Task 5.3.2: Prefer candidates whose recorded parent spanName matches live parent.
 * Task 5.4.1: createTopologyMatcher returns MOCK from selected candidate (seq key includes parent).
 */

import { testSpan } from '../bindings/test-span';
import { PostgresSpan } from '../bindings/postgres-span';
import type { SoftprobeCassetteRecord } from '../types/schema';
import { filterOutboundCandidates } from '../replay/extract-key';
import type { SpanKey } from '../replay/extract-key';
import {
  getLiveParentName,
  buildBySpanIdIndex,
  filterCandidatesByKey,
  selectLineagePool,
  createTopologyMatcher,
} from '../replay/topology';

describe('getLiveParentName', () => {
  it('returns _parentSpanName when span has it', () => {
    const span = { _parentSpanName: 'http-server' } as any;
    expect(getLiveParentName(span)).toBe('http-server');
  });

  it('returns "root" when span has no _parentSpanName', () => {
    const span = {} as any;
    expect(getLiveParentName(span)).toBe('root');
  });

  it('returns "root" when span is undefined', () => {
    expect(getLiveParentName(undefined)).toBe('root');
  });
});

describe('buildBySpanIdIndex', () => {
  it('builds map by spanId and recorded parent lookup works', () => {
    const parent: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't1',
      spanId: 'p1',
      spanName: 'http-server',
      timestamp: '2025-01-01T00:00:00Z',
      type: 'outbound',
      protocol: 'http',
      identifier: 'GET /',
    };
    const child: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't1',
      spanId: 'c1',
      parentSpanId: 'p1',
      spanName: 'pg-query',
      timestamp: '2025-01-01T00:00:01Z',
      type: 'outbound',
      protocol: 'postgres',
      identifier: 'SELECT 1',
    };
    const records = [parent, child];
    const bySpanId = buildBySpanIdIndex(records);

    expect(bySpanId.get('p1')).toBe(parent);
    expect(bySpanId.get('c1')).toBe(child);
    const lookedUpParent = bySpanId.get(child.parentSpanId!);
    expect(lookedUpParent).toBe(parent);
    expect(lookedUpParent?.spanName).toBe('http-server');
  });
});

describe('filterCandidatesByKey', () => {
  const outbound = (
    protocol: SpanKey['protocol'],
    identifier: string
  ): SoftprobeCassetteRecord => ({
    version: '4.1',
    traceId: 't1',
    spanId: 's1',
    timestamp: '2025-01-01T00:00:00Z',
    type: 'outbound',
    protocol,
    identifier,
  });
  const inbound = (
    protocol: SpanKey['protocol'],
    identifier: string
  ): SoftprobeCassetteRecord => ({
    ...outbound(protocol, identifier),
    type: 'inbound',
  });

  it('returns same result as flat filter (filterOutboundCandidates)', () => {
    const records: SoftprobeCassetteRecord[] = [
      outbound('postgres', 'SELECT 1'),
      outbound('postgres', 'SELECT 1'),
      inbound('postgres', 'SELECT 1'),
      outbound('postgres', 'SELECT 2'),
      outbound('http', 'GET /'),
    ];
    const key: SpanKey = { protocol: 'postgres', identifier: 'SELECT 1' };

    const topologyResult = filterCandidatesByKey(records, key);
    const flatResult = filterOutboundCandidates(records, key);

    expect(topologyResult).toEqual(flatResult);
    expect(topologyResult).toHaveLength(2);
    expect(topologyResult.every((r) => r.type === 'outbound' && r.identifier === 'SELECT 1')).toBe(
      true
    );
  });
});

describe('selectLineagePool', () => {
  const baseRecord = (overrides: Partial<SoftprobeCassetteRecord>): SoftprobeCassetteRecord => ({
    version: '4.1',
    traceId: 't1',
    spanId: 's1',
    timestamp: '2025-01-01T00:00:00Z',
    type: 'outbound',
    protocol: 'postgres',
    identifier: 'SELECT 1',
    ...overrides,
  });

  it('returns lineageMatches when some candidates match live parent', () => {
    const parentA = baseRecord({ spanId: 'pA', spanName: 'http-server', identifier: 'GET /', protocol: 'http' });
    const parentB = baseRecord({ spanId: 'pB', spanName: 'other', identifier: 'GET /other', protocol: 'http' });
    const childA = baseRecord({ spanId: 'cA', parentSpanId: 'pA', responsePayload: { rows: [1] } });
    const childB = baseRecord({ spanId: 'cB', parentSpanId: 'pB', responsePayload: { rows: [2] } });
    const records = [parentA, parentB, childA, childB];
    const bySpanId = buildBySpanIdIndex(records);
    const candidates = [childA, childB];

    const pool = selectLineagePool(candidates, bySpanId, 'http-server');

    expect(pool).toHaveLength(1);
    expect(pool[0]).toBe(childA);
    expect(pool[0]?.responsePayload).toEqual({ rows: [1] });
  });

  it('returns other lineageMatches when live parent is different', () => {
    const parentA = baseRecord({ spanId: 'pA', spanName: 'http-server', identifier: 'GET /', protocol: 'http' });
    const parentB = baseRecord({ spanId: 'pB', spanName: 'other', identifier: 'GET /other', protocol: 'http' });
    const childA = baseRecord({ spanId: 'cA', parentSpanId: 'pA' });
    const childB = baseRecord({ spanId: 'cB', parentSpanId: 'pB' });
    const bySpanId = buildBySpanIdIndex([parentA, parentB, childA, childB]);
    const candidates = [childA, childB];

    const pool = selectLineagePool(candidates, bySpanId, 'other');

    expect(pool).toHaveLength(1);
    expect(pool[0]).toBe(childB);
  });

  it('returns candidates when no lineage match (lineageMatches empty)', () => {
    const parentA = baseRecord({ spanId: 'pA', spanName: 'http-server', identifier: 'GET /', protocol: 'http' });
    const childA = baseRecord({ spanId: 'cA', parentSpanId: 'pA' });
    const childB = baseRecord({ spanId: 'cB', parentSpanId: 'pA' });
    const bySpanId = buildBySpanIdIndex([parentA, childA, childB]);
    const candidates = [childA, childB];

    const pool = selectLineagePool(candidates, bySpanId, 'unknown-parent');

    expect(pool).toEqual(candidates);
    expect(pool).toHaveLength(2);
  });

  it('returns candidate with no parent when liveParentName is "root"', () => {
    const rootChild = baseRecord({ spanId: 'c1', responsePayload: { rows: [] } });
    const bySpanId = buildBySpanIdIndex([rootChild]);
    const candidates = [rootChild];

    const pool = selectLineagePool(candidates, bySpanId, 'root');

    expect(pool).toHaveLength(1);
    expect(pool[0]).toBe(rootChild);
  });
});

describe('createTopologyMatcher', () => {
  const baseRecord = (overrides: Partial<SoftprobeCassetteRecord>): SoftprobeCassetteRecord => ({
    version: '4.1',
    traceId: 't1',
    spanId: 's1',
    timestamp: '2025-01-01T00:00:00Z',
    type: 'outbound',
    protocol: 'postgres',
    identifier: 'SELECT 1',
    ...overrides,
  });

  it('returns MOCK with correct payload for two identical identifiers under different parents', () => {
    const parentA = baseRecord({
      spanId: 'pA',
      spanName: 'http-server',
      identifier: 'GET /',
      protocol: 'http',
    });
    const parentB = baseRecord({
      spanId: 'pB',
      spanName: 'other',
      identifier: 'GET /other',
      protocol: 'http',
    });
    const childA = baseRecord({
      spanId: 'cA',
      parentSpanId: 'pA',
      responsePayload: { rows: [1], rowCount: 1 },
    });
    const childB = baseRecord({
      spanId: 'cB',
      parentSpanId: 'pB',
      responsePayload: { rows: [2], rowCount: 1 },
    });
    const records = [parentA, parentB, childA, childB];
    const match = createTopologyMatcher();

    const span1 = testSpan();
    PostgresSpan.tagQuery('SELECT 1', undefined, span1);
    (span1 as any)._parentSpanName = 'http-server';

    const span2 = testSpan();
    PostgresSpan.tagQuery('SELECT 1', undefined, span2);
    (span2 as any)._parentSpanName = 'other';

    const r1 = match(span1 as any, records);
    const r2 = match(span2 as any, records);

    expect(r1.action).toBe('MOCK');
    expect((r1 as { payload: unknown }).payload).toEqual({ rows: [1], rowCount: 1 });
    expect(r2.action).toBe('MOCK');
    expect((r2 as { payload: unknown }).payload).toEqual({ rows: [2], rowCount: 1 });
  });
});
