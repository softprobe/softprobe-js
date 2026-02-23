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
import { RedisSpan } from '../bindings/redis-span';
import type { MatcherAction } from '../types/schema';
import { softprobe } from '../api';

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
            const matcher = softprobe.getActiveMatcher();
            if (!matcher) {
              return (originalExecutor as (this: unknown, c: unknown, a: unknown[], n: string) => unknown).call(
                this,
                command,
                args,
                _name
              );
            }
            const { args: redisArgs } = transformCommandArguments(command, args);
            const cmd = (redisArgs[0] != null ? String(redisArgs[0]) : 'UNKNOWN');
            const cmdArgs = redisArgs.slice(1).map((a: unknown) => (a != null ? String(a) : ''));
            RedisSpan.tagCommand(cmd, cmdArgs, trace.getActiveSpan());
            const identifier = buildIdentifier(redisArgs);
            let payload: unknown;
            const softprobeMatcher = matcher as { match?: () => MatcherAction };
            if (typeof softprobeMatcher.match === 'function') {
              const r = softprobeMatcher.match();
              if (r.action === 'MOCK') {
                payload = r.payload;
              } else if (r.action === 'PASSTHROUGH') {
                return (originalExecutor as (this: unknown, c: unknown, a: unknown[], n: string) => unknown).call(
                  this,
                  command,
                  args,
                  _name
                );
              } else if (process.env.SOFTPROBE_STRICT_REPLAY === '1') {
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
                if (process.env.SOFTPROBE_STRICT_REPLAY === '1') {
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
              if (process.env.SOFTPROBE_STRICT_REPLAY === '1') {
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
    require('redis');
  } catch {
    // redis optional; tests will require it
  }
}
