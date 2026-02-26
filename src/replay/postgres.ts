/**
 * Postgres replay: patches pg.Client.prototype.query so that under replay context
 * calls are resolved by the SemanticMatcher (no live network). Pairs with capture
 * Task 4.2; identifier = query text per design §3.1, §6.
 */

import shimmer from 'shimmer';
import { trace } from '@opentelemetry/api';
import type { SemanticMatcher } from './matcher';
import type { SoftprobeMatcher } from './softprobe-matcher';
import { SoftprobeContext } from '../context';
import { PostgresSpan } from '../bindings/postgres-span';

const FATAL_IMPORT_ORDER =
  "[Softprobe FATAL] OTel already wrapped pg. Import 'softprobe/init' BEFORE OTel initialization.";

/**
 * Patches a pg module so connect is no-op and query uses matcher. Idempotent.
 * Exported so init can call it from a require hook and patch whichever module first requires 'pg' (Task 16.3.1).
 */
export function applyPostgresReplay(pg: { Client: { prototype: Record<string, unknown> } }): void {
  if ((pg.Client.prototype.query as { __wrapped?: boolean }).__wrapped) {
    return;
  }

  const connectKey = 'connect' as const;
  if (!(pg.Client.prototype[connectKey] as { __wrapped?: boolean })?.__wrapped) {
    shimmer.wrap(
      pg.Client.prototype,
      connectKey,
      (originalConnect: (...args: unknown[]) => unknown) =>
        function wrappedConnect(this: unknown, ...args: unknown[]): unknown {
          if (SoftprobeContext.getMode() === 'REPLAY') return Promise.resolve();
          return (originalConnect as (...a: unknown[]) => unknown).apply(this, args);
        }
    );
  }
  // end() must not touch the network when we never connected (Task 16.3.1).
  const endKey = 'end' as const;
  if (typeof pg.Client.prototype[endKey] === 'function' && !(pg.Client.prototype[endKey] as { __wrapped?: boolean })?.__wrapped) {
    shimmer.wrap(
      pg.Client.prototype,
      endKey,
      (originalEnd: (...args: unknown[]) => unknown) =>
        function wrappedEnd(this: unknown, ...args: unknown[]): unknown {
          if (SoftprobeContext.getMode() === 'REPLAY') return Promise.resolve();
          return (originalEnd as (...a: unknown[]) => unknown).apply(this, args);
        }
    );
  }

  shimmer.wrap(
    pg.Client.prototype,
    'query',
    (originalQuery: (...args: unknown[]) => unknown) =>
      function wrappedQuery(this: unknown, ...args: unknown[]): unknown {
        const matcher = SoftprobeContext.active().matcher;
        if (!matcher) {
          if (SoftprobeContext.getMode() === 'REPLAY' && SoftprobeContext.getStrictReplay()) {
            const strictErr = new Error('Softprobe replay: no match for pg.query');
            const lastArg = args[args.length - 1];
            const cb = typeof lastArg === 'function' ? (lastArg as (err: Error | null, res?: unknown) => void) : undefined;
            if (cb) {
              process.nextTick(() => cb(strictErr));
              return undefined;
            }
            return Promise.reject(strictErr);
          }
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
            if (SoftprobeContext.getStrictReplay()) {
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
            if (SoftprobeContext.getStrictReplay()) {
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

/**
 * Sets up Postgres replay. Triggers require('pg') so the init require hook runs and patches pg.
 * If the hook already patched (REPLAY), applyPostgresReplay is no-op; otherwise throw if OTel wrapped first.
 */
export function setupPostgresReplay(): void {
  const pg = require('pg');
  if ((pg.Client.prototype.query as { __wrapped?: boolean }).__wrapped && SoftprobeContext.getMode() !== 'REPLAY') {
    throw new Error(FATAL_IMPORT_ORDER);
  }
  applyPostgresReplay(pg);
}
