/**
 * Postgres replay: patches pg.Client.prototype.query so that under replay context
 * calls are resolved by the SemanticMatcher (no live network). Pairs with capture
 * Task 4.2; identifier = query text per design §3.1, §6.
 */

import shimmer from 'shimmer';
import type { SemanticMatcher } from './matcher';
import { softprobe } from '../api';

/**
 * Sets up Postgres replay by wrapping pg.Client.prototype.query. When replay context
 * has a matcher, queries are intercepted and return the recorded response payload
 * (rows/rowCount). If no matcher or no match, throws per AC4 (unmocked query).
 */
export function setupPostgresReplay(): void {
  const pg = require('pg');
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

        const cb = typeof args[1] === 'function' ? args[1] : typeof args[2] === 'function' ? args[2] : undefined;
        const vals = Array.isArray(args[1]) ? args[1] : undefined;

        let payload: unknown;
        try {
          // Replay tests inject SemanticMatcher. SoftprobeMatcher support is Phase 9.
          payload = (matcher as SemanticMatcher).findMatch({
            protocol: 'postgres',
            identifier: queryString,
            requestBody: vals,
          });
        } catch (err) {
          if (cb) {
            process.nextTick(() => (cb as (err: Error | null, res?: unknown) => void)(err as Error));
            return undefined;
          }
          return Promise.reject(err);
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
