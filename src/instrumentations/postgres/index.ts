/**
 * Postgres instrumentation package entry point.
 */
export {
  PG_INSTRUMENTATION_NAME,
  buildPostgresRequestHook,
  buildPostgresResponseHook,
} from './capture';
export { applyPostgresReplay, setupPostgresReplay } from './replay';
