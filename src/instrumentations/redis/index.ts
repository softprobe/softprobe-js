/**
 * Redis instrumentation package entry point.
 */
export { REDIS_INSTRUMENTATION_NAME, buildRedisResponseHook } from './capture';
export { applyRedisReplay, setupRedisReplay } from './replay';
