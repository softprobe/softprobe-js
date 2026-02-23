/**
 * Task 4.1.1: extractKeyFromSpan uses typed bindings; pg/redis/http yield { protocol, identifier }; unknown yields null.
 */

import { testSpan } from '../bindings/test-span';
import { PostgresSpan } from '../bindings/postgres-span';
import { RedisSpan } from '../bindings/redis-span';
import { HttpSpan } from '../bindings/http-span';
import type { SoftprobeCassetteRecord } from '../types/schema';
import {
  extractKeyFromSpan,
  filterOutboundCandidates,
  CallSeq,
} from '../replay/extract-key';

describe('extractKeyFromSpan', () => {
  it('yields { protocol, identifier } for postgres-tagged span', () => {
    const span = testSpan();
    PostgresSpan.tagQuery('SELECT 1', undefined, span);

    expect(extractKeyFromSpan(span)).toEqual({ protocol: 'postgres', identifier: 'SELECT 1' });
  });

  it('yields { protocol, identifier } for redis-tagged span', () => {
    const span = testSpan();
    RedisSpan.tagCommand('get', ['user:1:cache'], span);

    expect(extractKeyFromSpan(span)).toEqual({ protocol: 'redis', identifier: 'GET user:1:cache' });
  });

  it('yields { protocol, identifier } for http-tagged span', () => {
    const span = testSpan();
    HttpSpan.tagRequest('GET', 'https://api.example.com/users', undefined, span);

    expect(extractKeyFromSpan(span)).toEqual({
      protocol: 'http',
      identifier: 'GET https://api.example.com/users',
    });
  });

  it('yields null for unknown span (no protocol)', () => {
    const span = testSpan();
    // no tags

    expect(extractKeyFromSpan(span)).toBeNull();
  });
});

describe('filterOutboundCandidates', () => {
  const outboundPostgres = (identifier: string): SoftprobeCassetteRecord => ({
    version: '4.1',
    traceId: 't1',
    spanId: 's1',
    timestamp: new Date().toISOString(),
    type: 'outbound',
    protocol: 'postgres',
    identifier,
  });
  const inboundPostgres = (identifier: string): SoftprobeCassetteRecord => ({
    ...outboundPostgres(identifier),
    type: 'inbound',
  });

  it('returns only outbound records with matching protocol and identifier', () => {
    const records: SoftprobeCassetteRecord[] = [
      outboundPostgres('SELECT 1'),
      outboundPostgres('SELECT 1'),
      inboundPostgres('SELECT 1'),
      { ...outboundPostgres('SELECT 2'), identifier: 'SELECT 2' },
      { ...outboundPostgres('SELECT 1'), protocol: 'http' },
    ];
    const key = { protocol: 'postgres' as const, identifier: 'SELECT 1' };

    const got = filterOutboundCandidates(records, key);
    expect(got).toHaveLength(2);
    expect(got.every((r: SoftprobeCassetteRecord) => r.type === 'outbound' && r.protocol === 'postgres' && r.identifier === 'SELECT 1')).toBe(true);
  });
});

describe('CallSeq', () => {
  it('two calls pick candidates[0], then candidates[1]', () => {
    const callSeq = new CallSeq();
    const key = { protocol: 'postgres' as const, identifier: 'SELECT 1' };
    const candidates: SoftprobeCassetteRecord[] = [
      { version: '4.1', traceId: 't', spanId: 's1', timestamp: '', type: 'outbound', protocol: 'postgres', identifier: 'SELECT 1', responsePayload: { first: true } },
      { version: '4.1', traceId: 't', spanId: 's2', timestamp: '', type: 'outbound', protocol: 'postgres', identifier: 'SELECT 1', responsePayload: { second: true } },
    ];
    const idx0 = callSeq.getAndIncrement(key);
    const idx1 = callSeq.getAndIncrement(key);
    expect(idx0).toBe(0);
    expect(idx1).toBe(1);
    expect(candidates[idx0].responsePayload).toEqual({ first: true });
    expect(candidates[idx1].responsePayload).toEqual({ second: true });
  });

  it('wrap-around: 1 candidate always returns 0; 2 candidates called 3 times returns 0, 1, 0', () => {
    const key = { protocol: 'postgres' as const, identifier: 'SELECT 1' };
    const oneCandidate = [{ version: '4.1', traceId: 't', spanId: 's1', timestamp: '', type: 'outbound', protocol: 'postgres', identifier: 'SELECT 1' }];
    const twoCandidates = [
      { version: '4.1', traceId: 't', spanId: 's1', timestamp: '', type: 'outbound', protocol: 'postgres', identifier: 'SELECT 1' },
      { version: '4.1', traceId: 't', spanId: 's2', timestamp: '', type: 'outbound', protocol: 'postgres', identifier: 'SELECT 1' },
    ];
    const seq1 = new CallSeq();
    expect(seq1.getAndIncrement(key, oneCandidate.length)).toBe(0);
    expect(seq1.getAndIncrement(key, oneCandidate.length)).toBe(0);
    expect(seq1.getAndIncrement(key, oneCandidate.length)).toBe(0);
    const seq2 = new CallSeq();
    expect(seq2.getAndIncrement(key, twoCandidates.length)).toBe(0);
    expect(seq2.getAndIncrement(key, twoCandidates.length)).toBe(1);
    expect(seq2.getAndIncrement(key, twoCandidates.length)).toBe(0);
  });
});
