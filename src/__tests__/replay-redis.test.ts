/**
 * Task 5.3: Redis Replay.
 * Asserts a Redis command under replay context is intercepted, does not hit
 * the network, and the response comes from the SemanticMatcher.
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SemanticMatcher } from '../replay/matcher';
import { softprobe } from '../api';
import { initGlobalContext } from '../context';
import { setupRedisReplay } from '../replay/redis';
import { RedisSpan } from '../bindings/redis-span';

function mockRedisSpan(identifier: string, responseBody: unknown): ReadableSpan {
  return {
    attributes: {
      'softprobe.protocol': 'redis',
      'softprobe.identifier': identifier,
      'softprobe.response.body': JSON.stringify(responseBody),
    },
  } as unknown as ReadableSpan;
}

describe('Redis Replay (Task 5.3)', () => {
  beforeAll(() => {
    setupRedisReplay();
  });

  afterEach(() => {
    softprobe.clearReplayContext();
  });

  it('returns mocked response from SemanticMatcher and does not hit the network', async () => {
    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'myvalue'),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { createClient } = require('redis');
    const client = createClient();
    const result = await client.get('mykey');

    expect(result).toBe('myvalue');
  });

  it('throws when command is unmocked (no recorded span for identifier)', async () => {
    initGlobalContext({ strictReplay: true });

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'ok'),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { createClient } = require('redis');
    const client = createClient();

    await expect(client.get('otherkey')).rejects.toThrow(
      /no match for redis command/
    );

    initGlobalContext({ strictReplay: false });
  });
});

/**
 * Task 9.3: Redis replay wrapper.
 * Wrapper tags span via RedisSpan.tagCommand; MOCK/PASSTHROUGH/CONTINUE (strict vs dev).
 */
describe('Redis Replay (Task 9.3)', () => {
  beforeAll(() => {
    setupRedisReplay();
  });

  afterEach(() => {
    softprobe.clearReplayContext();
  });

  it('9.3.1 wrapper tags span via RedisSpan.tagCommand with cmd and args', async () => {
    const tagCommandSpy = jest.spyOn(RedisSpan, 'tagCommand').mockImplementation(() => {});

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'myvalue'),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { createClient } = require('redis');
    const client = createClient();
    await client.get('mykey');

    expect(tagCommandSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^get$/i),
      ['mykey'],
      undefined
    );
    tagCommandSpy.mockRestore();
  });

  it('9.3.2 MOCK path returns resolved promise with payload value', async () => {
    const mockedValue = { cached: true, id: 42 };
    const matcher = new SemanticMatcher([
      mockRedisSpan('GET user:1', mockedValue),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { createClient } = require('redis');
    const client = createClient();
    const result = await client.get('user:1');

    expect(result).toEqual(mockedValue);
  });

  it('9.3.3 CONTINUE + STRICT throws when strictReplay and no match', async () => {
    initGlobalContext({ strictReplay: true });

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'ok'),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { createClient } = require('redis');
    const client = createClient();

    await expect(client.get('otherkey')).rejects.toThrow(/no match for redis command/);

    initGlobalContext({ strictReplay: false });
  });

  it('9.3.4 CONTINUE + DEV passthrough invokes original when no match and strict not set', async () => {
    initGlobalContext({ strictReplay: false });

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'ok'),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { createClient } = require('redis');
    const client = createClient();

    // Passthrough: original executor is invoked, so we must not get replay errors
    try {
      await client.get('otherkey');
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? '';
      expect(msg).not.toMatch(/No recorded traces|no match for redis command/);
    }
  });
});

/**
 * Task 18.2.1: Redis shim uses Context lookup; sendCommand no-ops when mode === 'REPLAY' (no real send).
 */
describe('Task 18.2.1 Redis shim context-lookup', () => {
  beforeAll(() => {
    setupRedisReplay();
  });

  afterEach(() => {
    softprobe.clearReplayContext();
  });

  it('sendCommand no-ops when getSoftprobeContext().mode === REPLAY and no matcher', async () => {
    initGlobalContext({ mode: 'REPLAY', cassettePath: '' });

    const { createClient } = require('redis');
    const client = createClient();

    await expect(client.get('anykey')).rejects.toThrow(/no match for redis command/);

    initGlobalContext({ mode: 'PASSTHROUGH', cassettePath: '' });
  });
});
