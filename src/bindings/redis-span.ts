/**
 * Typed binding for Redis spans (design §7.2).
 * tagCommand sets protocol, identifier (via redisIdentifier), cmd, and args_json.
 */

import { redisIdentifier } from '../identifier';

/** Span-like with setAttribute (OTel Span or test span). */
type SpanLike = { setAttribute?(key: string, value: unknown): void } | undefined;

/** Span-like with readable attributes. */
type ReadableSpan = { attributes?: Record<string, unknown> } | undefined;

/** Data extracted from a redis-tagged span by fromSpan. */
export type RedisSpanData = {
  protocol: 'redis';
  identifier: string;
  cmd: string;
  args: string[];
};

/**
 * Tags the span with redis protocol, identifier (from redisIdentifier), and args as JSON.
 *
 * @param cmd - Command name (e.g. 'get').
 * @param args - Command arguments (string array).
 * @param span - Target span; pass test span in tests.
 */
export function tagCommand(cmd: string, args: string[], span?: SpanLike): void {
  if (!span?.setAttribute) return;
  span.setAttribute('softprobe.protocol', 'redis');
  span.setAttribute('softprobe.identifier', redisIdentifier(cmd, args));
  span.setAttribute('softprobe.redis.cmd', cmd.toUpperCase());
  span.setAttribute('softprobe.redis.args_json', JSON.stringify(args));
}

/**
 * Reads protocol, identifier, cmd, and args from a span. Returns redis data when
 * the span is tagged with redis protocol and has identifier and cmd; otherwise null.
 * args_json is parsed as JSON; invalid or missing yields [].
 */
export function fromSpan(span: ReadableSpan): RedisSpanData | null {
  const protocol = span?.attributes?.['softprobe.protocol'];
  if (protocol !== 'redis') return null;
  const identifier = span?.attributes?.['softprobe.identifier'];
  const cmd = span?.attributes?.['softprobe.redis.cmd'];
  if (typeof identifier !== 'string' || !cmd) return null;
  const argsJson = span?.attributes?.['softprobe.redis.args_json'];
  const args =
    typeof argsJson === 'string'
      ? (JSON.parse(argsJson) ?? [])
      : [];
  return { protocol: 'redis', identifier, cmd: String(cmd), args };
}

/** RedisSpan namespace for tagCommand and fromSpan. */
export const RedisSpan = { tagCommand, fromSpan };
