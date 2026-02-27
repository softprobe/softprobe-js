/**
 * Redis replay: patches Redis client so that under replay context commands are
 * resolved by matcher actions (no live network). Pairs with capture Task 4.5;
 * identifier = command + args per design §3.1, §6.3.
 *
 * We wrap the commander's attachCommands so that the executor passed to each
 * command (get, set, etc.) is our wrapper; the client captures that executor in
 * a closure when the module loads, so we must patch before the client loads.
 */

import { trace } from '@opentelemetry/api';
import shimmer from 'shimmer';
import { RedisSpan } from '../../bindings/redis-span';
import type { MatcherAction } from '../../types/schema';
import { SoftprobeContext } from '../../context';

/**
 * Builds the same identifier string as the Redis capture hook (capture/redis.ts):
 * command name (uppercase) plus args joined by space.
 */
function buildIdentifier(redisArgs: unknown[]): string {
  if (!Array.isArray(redisArgs) || redisArgs.length === 0) return '';
  const cmd = (redisArgs[0] != null ? String(redisArgs[0]) : 'UNKNOWN').toUpperCase();
  const rest = redisArgs.slice(1).map((a) => (a != null ? String(a) : ''));
  return [cmd, ...rest].join(' ').trim();
}

/**
 * Sets up Redis replay by wrapping the commander's attachCommands so the
 * executor used by get/set/etc. is our wrapper (matcher-aware). Must run
 * before the redis client module is loaded so the closure captures our wrapper.
 */
export function setupRedisReplay(): void {
  const commanderModule = require('@redis/client/dist/lib/commander');
  const { transformCommandArguments, transformCommandReply } = commanderModule;
  if (!transformCommandArguments || !transformCommandReply) return;

  shimmer.wrap(
    commanderModule,
    'attachCommands',
    (originalAttachCommands: (...args: unknown[]) => unknown) =>
      (config: unknown) => {
        const cfg = config as { BaseClass: unknown; commands: unknown; executor: (this: unknown, command: unknown, args: unknown[], name: string) => unknown };
        const originalExecutor = cfg.executor;
        const wrappedConfig = {
          ...cfg,
          executor: function patchedExecutor(
            this: unknown,
            command: unknown,
            args: unknown[],
            _name: string
          ): unknown {
            const matcher = SoftprobeContext.active().matcher;
            const mode = SoftprobeContext.getMode();
            const strictReplay = SoftprobeContext.getStrictReplay();
            if (mode === 'REPLAY' && !matcher && strictReplay) {
              return Promise.reject(new Error('Softprobe replay: no match for redis command'));
            }
            const { args: redisArgs } = transformCommandArguments(command, args);
            const cmd = (redisArgs[0] != null ? String(redisArgs[0]) : 'UNKNOWN').toUpperCase();
            if (mode === 'REPLAY' && (cmd === 'QUIT' || cmd === 'DISCONNECT')) {
              return Promise.resolve('OK');
            }
            if (!matcher) {
              return (originalExecutor as (this: unknown, c: unknown, a: unknown[], n: string) => unknown).call(
                this,
                command,
                args,
                _name
              );
            }
            const cmdArgs = redisArgs.slice(1).map((a: unknown) => (a != null ? String(a) : ''));
            RedisSpan.tagCommand(cmd, cmdArgs, trace.getActiveSpan() ?? undefined);
            const identifier = buildIdentifier(redisArgs);
            let payload: unknown;
            const softprobeMatcher = matcher as { match?: () => MatcherAction };
            if (typeof softprobeMatcher.match === 'function') {
              const r = (softprobeMatcher as { match?: (spanOverride?: { attributes?: Record<string, unknown> }) => MatcherAction }).match?.({
                attributes: {
                  'softprobe.protocol': 'redis',
                  'softprobe.identifier': identifier,
                  'softprobe.redis.cmd': cmd,
                  'softprobe.request.body': JSON.stringify(redisArgs),
                },
              }) as MatcherAction;
              if (r.action === 'MOCK') {
                payload = r.payload;
              } else if (r.action === 'PASSTHROUGH') {
                return (originalExecutor as (this: unknown, c: unknown, a: unknown[], n: string) => unknown).call(
                  this,
                  command,
                  args,
                  _name
                );
              } else if (strictReplay) {
                return Promise.reject(new Error('Softprobe replay: no match for redis command'));
              } else {
                // CONTINUE + DEV: passthrough (design §9.3)
                return (originalExecutor as (this: unknown, c: unknown, a: unknown[], n: string) => unknown).call(
                  this,
                  command,
                  args,
                  _name
                );
              }
            } else {
              try {
                payload = (matcher as {
                  findMatch: (req: {
                    protocol: string;
                    identifier: string;
                    requestBody?: unknown;
                  }) => unknown;
                }).findMatch({
                  protocol: 'redis',
                  identifier,
                  requestBody: redisArgs,
                });
              } catch (err) {
                if (strictReplay) {
                  return Promise.reject(new Error('Softprobe replay: no match for redis command'));
                }
                // CONTINUE + DEV: passthrough (design §9.3)
                return (originalExecutor as (this: unknown, c: unknown, a: unknown[], n: string) => unknown).call(
                  this,
                  command,
                  args,
                  _name
                );
              }
            }

            if (typeof payload === 'undefined') {
              if (strictReplay) {
                return Promise.reject(new Error('Softprobe replay: no match for redis command'));
              }
              // CONTINUE + DEV: passthrough (design §9.3)
              return (originalExecutor as (this: unknown, c: unknown, a: unknown[], n: string) => unknown).call(
                this,
                command,
                args,
                _name
              );
            } 
            const preserved = (redisArgs as { preserve?: boolean })?.preserve;
            return Promise.resolve(transformCommandReply(command, payload, preserved));
          },
        };
        return (originalAttachCommands as (c: unknown) => void)(wrappedConfig);
      }
  );

  // Ensure client module loads after our patch so attachCommands uses our wrapper
  try {
    const redis = require('redis');
    applyRedisReplay(redis);
  } catch {
    // redis optional; tests will require it
  }
}

type RedisClientLike = Record<string, unknown> & {
  connect?: (...args: unknown[]) => unknown;
  quit?: (...args: unknown[]) => unknown;
  QUIT?: (...args: unknown[]) => unknown;
};

/**
 * Wraps connect/quit/QUIT on a single Redis client instance as own properties.
 * Own-property wrappers shadow the prototype and survive any prototype-chain reshuffling
 * caused by OTel's module re-patching at sdk.start().
 */
function applyInstanceNoops(client: RedisClientLike): void {
  if (typeof client.connect === 'function') {
    const orig = client.connect;
    client.connect = function (this: unknown, ...args: unknown[]): unknown {
      if (SoftprobeContext.getMode() === 'REPLAY') return Promise.resolve();
      return orig.apply(this, args);
    };
  }
  const noopQuitFn = (orig: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]): unknown {
      if (SoftprobeContext.getMode() === 'REPLAY') return Promise.resolve('OK');
      return orig.apply(this, args);
    };
  if (typeof client.quit === 'function') client.quit = noopQuitFn(client.quit);
  if (typeof client.QUIT === 'function') client.QUIT = noopQuitFn(client.QUIT);
}

const SOFTPROBE_CREATE_CLIENT_WRAPPED = '__softprobeCreateClientWrapped';

/**
 * Wraps createClient so every new client gets connect/quit no-ops as instance own-properties.
 * Using instance-level patching (not prototype) makes it immune to OTel re-patching the redis
 * module at sdk.start(), which creates new Commander prototype objects that would bypass a
 * prototype-level patch applied before sdk.start().
 * Idempotent. Exported so init can call it from a require hook (Task 16.3.1).
 */
export function applyRedisReplay(redis: Record<string, unknown>): void {
  const target = redis.createClient != null ? redis : (redis.default as Record<string, unknown> | undefined);
  if (!target) return;
  if ((target.createClient as { [SOFTPROBE_CREATE_CLIENT_WRAPPED]?: boolean })?.[SOFTPROBE_CREATE_CLIENT_WRAPPED]) return;

  shimmer.wrap(
    target,
    'createClient',
    (original: (...args: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const client = (original as (...a: unknown[]) => RedisClientLike).apply(this, args);
        applyInstanceNoops(client);
        return client;
      }
  );
  (target.createClient as { [SOFTPROBE_CREATE_CLIENT_WRAPPED]?: boolean })[SOFTPROBE_CREATE_CLIENT_WRAPPED] = true;
}
