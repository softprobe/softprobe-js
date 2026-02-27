/**
 * Legacy compatibility re-export for Postgres capture instrumentation.
 */
export {
  PG_INSTRUMENTATION_NAME,
  buildPostgresRequestHook,
  buildPostgresResponseHook,
} from '../instrumentations/postgres/capture';
export type { PgQueryInfo, PgResultInfo } from '../instrumentations/postgres/capture';
