/**
 * Task 3.4.1: HttpSpan.tagRequest uses httpIdentifier; body stored optionally.
 */

import { testSpan } from '../core/bindings/test-span';
import { HttpSpan } from '../core/bindings/http-span';

describe('HttpSpan.tagRequest', () => {
  it('sets identifier via httpIdentifier', () => {
    const span = testSpan();
    HttpSpan.tagRequest('GET', 'https://api.example.com/users', undefined, span);

    expect(span.attributes['softprobe.protocol']).toBe('http');
    expect(span.attributes['softprobe.identifier']).toBe('GET https://api.example.com/users');
  });

  it('stores body optionally when bodyText provided', () => {
    const span = testSpan();
    HttpSpan.tagRequest('POST', 'https://api.example.com/users', '{"name":"alice"}', span);

    expect(span.attributes['softprobe.identifier']).toBe('POST https://api.example.com/users');
    expect(span.attributes['softprobe.request.body']).toBe('{"name":"alice"}');
  });
});

describe('HttpSpan.fromSpan', () => {
  it('returns protocol and identifier when span is http-tagged', () => {
    const span = testSpan();
    HttpSpan.tagRequest('GET', 'https://api.example.com/users', undefined, span);

    const data = HttpSpan.fromSpan(span);
    expect(data).toEqual({ protocol: 'http', identifier: 'GET https://api.example.com/users' });
  });

  it('returns null when protocol is not http', () => {
    const span = testSpan();
    span.setAttribute('softprobe.protocol', 'postgres');
    span.setAttribute('softprobe.identifier', 'SELECT 1');

    expect(HttpSpan.fromSpan(span)).toBeNull();
  });
});
