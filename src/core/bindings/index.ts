/**
 * Shared span helper contracts and adapters.
 */
export { HttpSpan, tagRequest as tagHttpRequest, fromSpan as parseHttpSpan } from './http-span';
export type { HttpSpanData } from './http-span';
export { PostgresSpan, tagQuery as tagPostgresQuery, fromSpan as parsePostgresSpan } from './postgres-span';
export type { PostgresSpanData } from './postgres-span';
export { RedisSpan, tagCommand as tagRedisCommand, fromSpan as parseRedisSpan } from './redis-span';
export type { RedisSpanData } from './redis-span';
export { testSpan } from './test-span';
export type { TestSpan } from './test-span';
