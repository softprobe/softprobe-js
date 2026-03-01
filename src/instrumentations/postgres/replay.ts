/**
 * Postgres replay: patches pg.Client.prototype.query so that under replay context
 * calls are resolved by the SemanticMatcher (no live network). Pairs with capture
 * Task 4.2; identifier = query text per design §3.1, §6.
 */

import { trace } from '@opentelemetry/api';
import type { SemanticMatcher } from '../../core/matcher/matcher';
import type { SoftprobeMatcher } from '../../core/matcher/softprobe-matcher';
import { SoftprobeContext } from '../../context';
import { PostgresSpan } from '../../core/bindings/postgres-span';
import { settleAsync } from '../common/utils/callback';
import { isMethodWrappedWithMarker, wrapMethodNoConflict } from '../../core/runtime/wrap';

const QUERY_WRAPPED_MARKER = 'postgres.replay.query';
const CONNECT_WRAPPED_MARKER = 'postgres.replay.connect';
const END_WRAPPED_MARKER = 'postgres.replay.end';

/**
 * Patches a pg module so connect is no-op and query uses matcher. Idempotent.
 * Exported so init can call it from a require hook and patch whichever module first requires 'pg' (Task 16.3.1).
 */
export function applyPostgresReplay(pg: { Client: { prototype: Record<string, unknown> } }): void {
  if (isMethodWrappedWithMarker(pg.Client.prototype, 'query', QUERY_WRAPPED_MARKER)) return;

  const connectKey = 'connect' as const;
  wrapMethodNoConflict(
    pg.Client.prototype,
    connectKey,
    CONNECT_WRAPPED_MARKER,
    (origConnect: (...args: unknown[]) => unknown) =>
      function wrappedConnect(this: unknown, ...args: unknown[]): unknown {
        if (SoftprobeContext.getMode() === 'REPLAY') return settleAsync(args);
        return origConnect.apply(this, args);
      }
  );

  // end() must not touch the network when we never connected (Task 16.3.1). OTel does not wrap
  // end(), but we still use no-conflict wrapper metadata for consistency.
  const endKey = 'end' as const;
  wrapMethodNoConflict(
    pg.Client.prototype,
    endKey,
    END_WRAPPED_MARKER,
    (originalEnd: (...args: unknown[]) => unknown) =>
      function wrappedEnd(this: unknown, ...args: unknown[]): unknown {
        if (SoftprobeContext.getMode() === 'REPLAY') return settleAsync(args);
        return originalEnd.apply(this, args);
      }
  );

  // Use no-conflict metadata so OTel's __wrapped checks never treat Softprobe as wrapped.
  // OTel wraps our query wrapper with its span-creating wrapper; our wrapper stays in the chain.
  wrapMethodNoConflict(
    pg.Client.prototype,
    'query',
    QUERY_WRAPPED_MARKER,
    (origQuery: (...args: unknown[]) => unknown) =>
      function wrappedQuery(this: unknown, ...args: unknown[]): unknown {
        const matcher = SoftprobeContext.active().matcher;
        const mode = SoftprobeContext.getMode();
        const strictReplay = SoftprobeContext.getStrictReplay();
        if (!matcher) {
          if (mode === 'REPLAY' && strictReplay) {
            const replayErr = new Error('Softprobe replay: no match for pg.query');
            const lastArg = args[args.length - 1];
            const cb = typeof lastArg === 'function' ? (lastArg as (err: Error | null, res?: unknown) => void) : undefined;
            if (cb) {
              process.nextTick(() => cb(replayErr));
              return undefined;
            }
            return Promise.reject(replayErr);
          }
          return origQuery.apply(this, args);
        }

        const config = args[0];
        const queryString = typeof config === 'string' ? config : (config as { text?: string })?.text;
        if (typeof queryString !== 'string') {
          return origQuery.apply(this, args);
        }

        // Support both promise and callback style (design §9.1: callback is last arg).
        const lastArg = args[args.length - 1];
        const cb = typeof lastArg === 'function' ? (lastArg as (err: Error | null, res?: unknown) => void) : undefined;
        const valsArray = Array.isArray(args[1]) ? args[1] : undefined;

        PostgresSpan.tagQuery(queryString, valsArray, trace.getActiveSpan() ?? undefined);

        let payload: unknown;
        const softprobeMatcher = matcher as SoftprobeMatcher;
        if (typeof softprobeMatcher.match === 'function') {
          const r = softprobeMatcher.match({
            attributes: {
              'softprobe.protocol': 'postgres',
              'softprobe.identifier': queryString,
              ...(valsArray !== undefined && { 'softprobe.request.body': JSON.stringify(valsArray) }),
            },
          });
          if (r.action === 'MOCK') {
            payload = r.payload;
          } else if (r.action === 'PASSTHROUGH') {
            return origQuery.apply(this, args);
          } else {
            if (strictReplay) {
              const strictErr = new Error('Softprobe replay: no match for pg.query');
              if (cb) {
                process.nextTick(() => (cb as (err: Error | null, res?: unknown) => void)(strictErr));
                return undefined;
              }
              return Promise.reject(strictErr);
            }
            return origQuery.apply(this, args);
          }
        } else {
          try {
            payload = (matcher as SemanticMatcher).findMatch({
              protocol: 'postgres',
              identifier: queryString,
              requestBody: valsArray,
            });
          } catch (err) {
            if (strictReplay) {
              const strictErr = new Error('Softprobe replay: no match for pg.query');
              if (cb) {
                process.nextTick(() => (cb as (err: Error | null, res?: unknown) => void)(strictErr));
                return undefined;
              }
              return Promise.reject(strictErr);
            }
            return origQuery.apply(this, args);
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

/**
 * Sets up Postgres replay. Called from init so patches are in place before OTel.
 * Idempotent when already applied. OTel may wrap on top when sdk.start() runs.
 */
export function setupPostgresReplay(): void {
  const pg = require('pg');
  if (isMethodWrappedWithMarker(pg.Client.prototype, 'query', QUERY_WRAPPED_MARKER)) return;
  applyPostgresReplay(pg);
}
