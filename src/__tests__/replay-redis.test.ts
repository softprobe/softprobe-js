/**
 * Task 5.3: Redis Replay.
 * Asserts a Redis command under replay context is intercepted, does not hit
 * the network, and the response comes from the SemanticMatcher.
 */

import * as otelApi from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { SemanticMatcher } from '../core/matcher/matcher';
import { SoftprobeMatcher } from '../core/matcher/softprobe-matcher';
import { SoftprobeContext } from '../context';
import { setupRedisReplay } from '../instrumentations/redis/replay';
import { RedisSpan } from '../core/bindings/redis-span';
import { softprobe } from '../api';
import { runSoftprobeScope } from './helpers/run-softprobe-scope';

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
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupRedisReplay();
  });

  it('returns mocked response from SemanticMatcher and does not hit the network', async () => {
    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'myvalue'),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { createClient } = require('redis');
      const client = createClient();
      const result = await client.get('mykey');
      expect(result).toBe('myvalue');
    });
  });

  it('throws when command is unmocked (no recorded span for identifier)', async () => {
    SoftprobeContext.initGlobal({ strictReplay: true });

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'ok'),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { createClient } = require('redis');
      const client = createClient();
      await expect(client.get('otherkey')).rejects.toThrow(
        /no match for redis command/
      );
    });

    SoftprobeContext.initGlobal({ strictReplay: false });
  });
});

/**
 * Task 9.3: Redis replay wrapper.
 * Wrapper tags span via RedisSpan.tagCommand; MOCK/PASSTHROUGH/CONTINUE (strict vs dev).
 */
describe('Redis Replay (Task 9.3)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupRedisReplay();
  });

  it('9.3.1 wrapper tags span via RedisSpan.tagCommand with cmd and args', async () => {
    const tagCommandSpy = jest.spyOn(RedisSpan, 'tagCommand').mockImplementation(() => {});

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'myvalue'),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { createClient } = require('redis');
      const client = createClient();
      await client.get('mykey');
      expect(tagCommandSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^get$/i),
        ['mykey'],
        undefined
      );
    });
    tagCommandSpy.mockRestore();
  });

  it('9.3.2 MOCK path returns resolved promise with payload value', async () => {
    const mockedValue = { cached: true, id: 42 };
    const matcher = new SemanticMatcher([
      mockRedisSpan('GET user:1', mockedValue),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { createClient } = require('redis');
      const client = createClient();
      const result = await client.get('user:1');
      expect(result).toEqual(mockedValue);
    });
  });

  it('9.3.3 CONTINUE + STRICT throws when strictReplay and no match', async () => {
    SoftprobeContext.initGlobal({ strictReplay: true });

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'ok'),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { createClient } = require('redis');
      const client = createClient();
      await expect(client.get('otherkey')).rejects.toThrow(/no match for redis command/);
    });

    SoftprobeContext.initGlobal({ strictReplay: false });
  });

  it('9.3.4 CONTINUE + DEV passthrough invokes original when no match and strict not set', async () => {
    SoftprobeContext.initGlobal({ strictReplay: false });

    const matcher = new SemanticMatcher([
      mockRedisSpan('GET mykey', 'ok'),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
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
});

/**
 * Task 18.2.1: Redis shim uses Context lookup; sendCommand no-ops when mode === 'REPLAY' (no real send).
 */
describe('Task 18.2.1 Redis shim context-lookup', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupRedisReplay();
  });

  it('strict replay hard-fails when SoftprobeContext.getMode() === REPLAY and no matcher', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', strictReplay: true });

    const { createClient } = require('redis');
    const client = createClient();

    await expect(client.get('anykey')).rejects.toThrow(/no match for redis command/);

    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', strictReplay: false });
  });
});

describe('Task 6.2 Redis replay wrapper uses active context matcher only', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupRedisReplay();
  });

  afterEach(() => {
    softprobe.setGlobalReplayMatcher(undefined);
  });

  it('ignores global matcher fallback when active replay context has no matcher', async () => {
    const globalMatcher = new SoftprobeMatcher();
    globalMatcher.use(() => ({ action: 'MOCK', payload: 'global-value' }));
    softprobe.setGlobalReplayMatcher(globalMatcher);

    const activeCtx = otelApi.context.active();
    const replayCtxWithoutMatcher = SoftprobeContext.withData(activeCtx, {
      mode: 'REPLAY',
      traceId: 'redis-task-6-2',
    });

    await otelApi.context.with(replayCtxWithoutMatcher, async () => {
      const { createClient } = require('redis');
      const client = createClient();
      try {
        const value = await client.get('anykey');
        expect(value).not.toBe('global-value');
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? '';
        expect(msg).not.toMatch(/no match for redis command/);
      }
    });
  });
});

/**
 * Redis connect/quit in REPLAY: callback style must be invoked (settleAsync).
 */
describe('Redis replay connect/quit callback style', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupRedisReplay();
  });

  afterEach(() => {
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', strictReplay: false });
  });

  it('when REPLAY, client.connect(callback) invokes callback with (null, undefined)', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY' });

    const { createClient } = require('redis');
    const client = createClient();

    const result = await new Promise<undefined>((resolve, reject) => {
      client.connect((err: Error | null, value?: undefined) => {
        if (err) return reject(err);
        resolve(value);
      });
    });
    expect(result).toBeUndefined();
  });

  it('when REPLAY, client.quit(callback) invokes callback with (null, "OK")', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY' });

    const { createClient } = require('redis');
    const client = createClient();

    const result = await new Promise<string | undefined>((resolve, reject) => {
      client.quit((err: Error | null, value?: string) => {
        if (err) return reject(err);
        resolve(value);
      });
    });
    expect(result).toBe('OK');
  });

  it('when REPLAY, client.QUIT(callback) invokes callback with (null, "OK")', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY' });

    const { createClient } = require('redis');
    const client = createClient();

    const result = await new Promise<string | undefined>((resolve, reject) => {
      (client.QUIT as (cb: (err: Error | null, value?: string) => void) => void)((err: Error | null, value?: string) => {
        if (err) return reject(err);
        resolve(value);
      });
    });
    expect(result).toBe('OK');
  });
});

describe('Task 6.4: Wrapper strict/dev behavior remains wrapper-owned (Redis)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    setupRedisReplay();
  });

  afterEach(() => {
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', strictReplay: false });
  });

  it('dev replay passthroughs when no active matcher is available', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', strictReplay: false });
    const activeCtx = otelApi.context.active();
    const replayCtxWithoutMatcher = SoftprobeContext.withData(activeCtx, {
      mode: 'REPLAY',
      traceId: 'redis-task-6-4',
    });

    await otelApi.context.with(replayCtxWithoutMatcher, async () => {
      const { createClient } = require('redis');
      const client = createClient();
      try {
        await client.get('anykey');
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? '';
        expect(msg).not.toMatch(/no match for redis command/);
      }
    });
  });
});
