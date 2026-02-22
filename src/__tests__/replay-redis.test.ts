/**
 * Task 5.3: Redis Replay.
 * Asserts a Redis command under replay context is intercepted, does not hit
 * the network, and the response comes from the SemanticMatcher.
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SemanticMatcher } from '../replay/matcher';
import { softprobe } from '../api';
import { setupRedisReplay } from '../replay/redis';

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
    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'ok'),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { createClient } = require('redis');
    const client = createClient();

    await expect(client.get('otherkey')).rejects.toThrow(
      /\[Softprobe\] No recorded traces found for redis: GET otherkey/
    );
  });
});
