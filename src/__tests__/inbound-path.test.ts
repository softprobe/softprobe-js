import { resolveInboundPath } from '../instrumentations/common/http/inbound-path';

describe('resolveInboundPath', () => {
  it('prefers originalUrl for mounted Express router requests', () => {
    expect(resolveInboundPath({ originalUrl: '/products', url: '/', path: '/' })).toBe('/products');
  });

  it('preserves query parameters from originalUrl', () => {
    expect(resolveInboundPath({ originalUrl: '/products?page=2&sort=asc', path: '/' })).toBe('/products?page=2&sort=asc');
  });

  it('falls back to url when originalUrl is missing', () => {
    expect(resolveInboundPath({ url: '/ping?source=ui' })).toBe('/ping?source=ui');
  });

  it('falls back to path when originalUrl/url are missing', () => {
    expect(resolveInboundPath({ path: '/health' })).toBe('/health');
  });

  it('normalizes absolute URL input to path plus query only', () => {
    expect(resolveInboundPath({ url: 'https://api.example.com/items/1?expand=true' })).toBe('/items/1?expand=true');
  });

  it('drops fragment component when present', () => {
    expect(resolveInboundPath({ url: '/products?page=2#section-1' })).toBe('/products?page=2');
  });

  it('returns slash for empty input', () => {
    expect(resolveInboundPath({})).toBe('/');
    expect(resolveInboundPath({ url: '' })).toBe('/');
  });

  it('normalizes query-only URL into a rooted path', () => {
    expect(resolveInboundPath({ url: '?page=2' })).toBe('/?page=2');
  });
});
