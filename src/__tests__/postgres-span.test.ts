/**
 * Task 3.2.1: PostgresSpan.tagQuery sets protocol and identifier on span.
 */

import { testSpan } from '../core/bindings/test-span';
import { PostgresSpan } from '../core/bindings/postgres-span';

describe('PostgresSpan.tagQuery', () => {
  it('sets protocol attr and identifier attr', () => {
    const span = testSpan();
    PostgresSpan.tagQuery('SELECT 1', undefined, span);

    expect(span.attributes['softprobe.protocol']).toBe('postgres');
    expect(span.attributes['softprobe.identifier']).toBe('SELECT 1');
  });
});

describe('PostgresSpan.fromSpan', () => {
  it('returns { protocol, identifier, sql, values } when span is postgres-tagged', () => {
    const span = testSpan();
    PostgresSpan.tagQuery('SELECT 1', undefined, span);

    const data = PostgresSpan.fromSpan(span);
    expect(data).toEqual({
      protocol: 'postgres',
      identifier: 'SELECT 1',
      sql: 'SELECT 1',
      values: [],
    });
  });

  it('returns null when protocol is not postgres', () => {
    const span = testSpan();
    span.setAttribute('softprobe.protocol', 'http');
    span.setAttribute('softprobe.identifier', 'GET /');

    expect(PostgresSpan.fromSpan(span)).toBeNull();
  });
});
