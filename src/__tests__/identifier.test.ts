/**
 * Identifier builders (pure): httpIdentifier, redisIdentifier, pgIdentifier.
 */
import { httpIdentifier, redisIdentifier, pgIdentifier } from '../identifier';

describe('identifier builders', () => {
  describe('httpIdentifier', () => {
    it('returns "METHOD url" for POST and https://a/b', () => {
      expect(httpIdentifier('POST', 'https://a/b')).toBe('POST https://a/b');
    });
  });

  describe('redisIdentifier', () => {
    it('returns "CMD args" for get and ["k"]', () => {
      expect(redisIdentifier('get', ['k'])).toBe('GET k');
    });
  });

  describe('pgIdentifier', () => {
    it('keeps input string exactly (normalization deferred)', () => {
      const sql = 'SELECT * FROM users WHERE id = $1';
      expect(pgIdentifier(sql)).toBe(sql);
    });
  });
});
