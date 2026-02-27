/**
 * Pure identifier builders for capture/replay matching.
 * Keys must be built identically in capture and replay (design §6.2).
 */

/**
 * HTTP identifier: "METHOD url" (method uppercased).
 * @example httpIdentifier('POST', 'https://a/b') => 'POST https://a/b'
 */
export function httpIdentifier(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * Redis identifier: "CMD arg1 arg2 ..." (cmd uppercased, args joined by space).
 * @example redisIdentifier('get', ['k']) => 'GET k'
 */
export function redisIdentifier(cmd: string, args: string[]): string {
  return `${cmd.toUpperCase()} ${args.join(' ')}`.trim();
}

/**
 * Postgres identifier: pass-through of SQL string (normalization deferred).
 * Must be consistent in capture and replay; optional normalizeSql later.
 */
export function pgIdentifier(sql: string): string {
  return sql;
}
