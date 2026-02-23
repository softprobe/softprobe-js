/**
 * Postgres replay: patches pg.Client.prototype.query so that under replay context
 * calls are resolved by the SemanticMatcher (no live network). Pairs with capture
 * Task 4.2; identifier = query text per design §3.1, §6.
 */

import shimmer from 'shimmer';
import { trace } from '@opentelemetry/api';
import type { SemanticMatcher } from './matcher';
import type { SoftprobeMatcher } from './softprobe-matcher';
import { softprobe } from '../api';
import { PostgresSpan } from '../bindings/postgres-span';

const FATAL_IMPORT_ORDER =
  "[Softprobe FATAL] OTel already wrapped pg. Import 'softprobe/init' BEFORE OTel initialization.";

/**
 * Sets up Postgres replay by wrapping pg.Client.prototype.connect and query.
 * When a matcher is active, connect() is a no-op (no TCP) so replay works with DB offline;
 * query() returns recorded payloads. Design §9.1; Task 16.3.1 demo.
 */
export function setupPostgresReplay(): void {
  const pg = require('pg');
  if ((pg.Client.prototype.query as { __wrapped?: boolean }).__wrapped) {
    throw new Error(FATAL_IMPORT_ORDER);
  }

  // No-op connect in replay so demo can run with Postgres offline (Task 16.3.1).
  const connectKey = 'connect' as const;
  if (!(pg.Client.prototype[connectKey] as { __wrapped?: boolean })?.__wrapped) {
    shimmer.wrap(
      pg.Client.prototype,
      connectKey,
      (originalConnect: (...args: unknown[]) => unknown) =>
        function wrappedConnect(this: unknown, ...args: unknown[]): unknown {
          if (process.env.SOFTPROBE_MODE === 'REPLAY' && softprobe.getActiveMatcher()) {
            return Promise.resolve();
          }
          return (originalConnect as (...a: unknown[]) => unknown).apply(this, args);
        }
    );
  }

  shimmer.wrap(
    pg.Client.prototype,
    'query',
    (originalQuery: (...args: unknown[]) => unknown) =>
      function wrappedQuery(this: unknown, ...args: unknown[]): unknown {
        const matcher = softprobe.getActiveMatcher();
        if (!matcher) {
          return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
        }

        const config = args[0];
        const queryString = typeof config === 'string' ? config : (config as { text?: string })?.text;
        if (typeof queryString !== 'string') {
          return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
        }

        // Support both promise and callback style (design §9.1: callback is last arg).
        const lastArg = args[args.length - 1];
        const cb = typeof lastArg === 'function' ? (lastArg as (err: Error | null, res?: unknown) => void) : undefined;
        const valsArray = Array.isArray(args[1]) ? args[1] : undefined;

        PostgresSpan.tagQuery(queryString, valsArray, trace.getActiveSpan() ?? undefined);

        let payload: unknown;
        const softprobeMatcher = matcher as SoftprobeMatcher;
        if (typeof softprobeMatcher.match === 'function') {
          const spanLike = {
            attributes: {
              'softprobe.protocol': 'postgres',
              'softprobe.identifier': queryString,
            },
          } as { attributes: Record<string, unknown> };
          const r = softprobeMatcher.match(spanLike);
          if (r.action === 'MOCK') {
            payload = r.payload;
          } else if (r.action === 'PASSTHROUGH') {
            return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
          } else {
            if (process.env.SOFTPROBE_STRICT_REPLAY === '1') {
              const strictErr = new Error('Softprobe replay: no match for pg.query');
              if (cb) {
                process.nextTick(() => (cb as (err: Error | null, res?: unknown) => void)(strictErr));
                return undefined;
              }
              return Promise.reject(strictErr);
            }
            return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
          }
        } else {
          try {
            payload = (matcher as SemanticMatcher).findMatch({
              protocol: 'postgres',
              identifier: queryString,
              requestBody: valsArray,
            });
          } catch (err) {
            if (process.env.SOFTPROBE_STRICT_REPLAY === '1') {
              const strictErr = new Error('Softprobe replay: no match for pg.query');
              if (cb) {
                process.nextTick(() => (cb as (err: Error | null, res?: unknown) => void)(strictErr));
                return undefined;
              }
              return Promise.reject(strictErr);
            }
            return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
          }
        }

        const rows = Array.isArray(payload) ? payload : (payload as { rows?: unknown[] })?.rows ?? [];
        const rowCount = (payload as { rowCount?: number })?.rowCount ?? rows.length;
        const mockedResult = { rows, rowCount, command: 'SELECT', oid: 0, fields: [] };

        if (cb) {
          process.nextTick(() => (cb as (err: Error | null, res?: unknown) => void)(null, mockedResult));
          return undefined;
        }
        return Promise.resolve(mockedResult);
      }
  );
}
