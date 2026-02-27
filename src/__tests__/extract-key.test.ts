/**
 * Task 4.1.1: extractKeyFromSpan uses typed bindings; pg/redis/http yield { protocol, identifier }; unknown yields null.
 */

import { testSpan } from '../core/bindings/test-span';
import { PostgresSpan } from '../core/bindings/postgres-span';
import { RedisSpan } from '../core/bindings/redis-span';
import { HttpSpan } from '../core/bindings/http-span';
import type { SoftprobeCassetteRecord } from '../types/schema';
import {
  extractKeyFromSpan,
  filterOutboundCandidates,
  CallSeq,
} from '../core/matcher/extract-key';

describe('extractKeyFromSpan', () => {
  it('maps postgres/redis/http span bindings to deterministic { protocol, identifier } keys', () => {
    const pgSpan = testSpan();
    PostgresSpan.tagQuery('SELECT 42', undefined, pgSpan);

    const redisSpan = testSpan();
    RedisSpan.tagCommand('get', ['cache:user:42'], redisSpan);

    const httpSpan = testSpan();
    HttpSpan.tagRequest('POST', 'https://api.example.com/users', '{"name":"sam"}', httpSpan);

    expect(extractKeyFromSpan(pgSpan)).toEqual({
      protocol: 'postgres',
      identifier: 'SELECT 42',
    });
    expect(extractKeyFromSpan(redisSpan)).toEqual({
      protocol: 'redis',
      identifier: 'GET cache:user:42',
    });
    expect(extractKeyFromSpan(httpSpan)).toEqual({
      protocol: 'http',
      identifier: 'POST https://api.example.com/users',
    });
  });

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

  it('increments deterministically without wrap-around', () => {
    const key = { protocol: 'postgres' as const, identifier: 'SELECT 1' };
    const seq1 = new CallSeq();
    expect(seq1.getAndIncrement(key)).toBe(0);
    expect(seq1.getAndIncrement(key)).toBe(1);
    expect(seq1.getAndIncrement(key)).toBe(2);
    const seq2 = new CallSeq();
    expect(seq2.getAndIncrement(key)).toBe(0);
    expect(seq2.getAndIncrement(key)).toBe(1);
    expect(seq2.getAndIncrement(key)).toBe(2);
  });
});
