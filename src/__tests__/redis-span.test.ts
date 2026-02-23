/**
 * Task 3.3.1: RedisSpan.tagCommand uses redisIdentifier and sets args as JSON.
 */

import { testSpan } from '../bindings/test-span';
import { RedisSpan } from '../bindings/redis-span';

describe('RedisSpan.tagCommand', () => {
  it('sets identifier via redisIdentifier and args_json as JSON', () => {
    const span = testSpan();
    RedisSpan.tagCommand('get', ['user:1:cache'], span);

    expect(span.attributes['softprobe.protocol']).toBe('redis');
    expect(span.attributes['softprobe.identifier']).toBe('GET user:1:cache');
    expect(span.attributes['softprobe.redis.args_json']).toBe(JSON.stringify(['user:1:cache']));
  });
});

describe('RedisSpan.fromSpan', () => {
  it('parses args_json and returns redis data when span is redis-tagged', () => {
    const span = testSpan();
    RedisSpan.tagCommand('get', ['user:1:cache'], span);

    const data = RedisSpan.fromSpan(span);
    expect(data).toEqual({
      protocol: 'redis',
      identifier: 'GET user:1:cache',
      cmd: 'GET',
      args: ['user:1:cache'],
    });
  });

  it('returns null when cmd is missing', () => {
    const span = testSpan();
    span.setAttribute('softprobe.protocol', 'redis');
    span.setAttribute('softprobe.identifier', 'GET k');
    // no softprobe.redis.cmd

    expect(RedisSpan.fromSpan(span)).toBeNull();
  });

  it('returns null when identifier is missing', () => {
    const span = testSpan();
    span.setAttribute('softprobe.protocol', 'redis');
    span.setAttribute('softprobe.redis.cmd', 'GET');
    span.setAttribute('softprobe.redis.args_json', '["k"]');
    // no identifier

    expect(RedisSpan.fromSpan(span)).toBeNull();
  });
});
