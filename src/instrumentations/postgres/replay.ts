/**
 * Postgres replay: patches pg.Client.prototype.query so that under replay context
 * calls are resolved by the SemanticMatcher (no live network). Pairs with capture
 * Task 4.2; identifier = query text per design §3.1, §6.
 */

import shimmer from 'shimmer';
import { trace } from '@opentelemetry/api';
import type { SemanticMatcher } from '../../replay/matcher';
import type { SoftprobeMatcher } from '../../replay/softprobe-matcher';
import { SoftprobeContext } from '../../context';
import { PostgresSpan } from '../../bindings/postgres-span';

const SOFTPROBE_WRAPPED_MARKER = '__softprobeWrapped';

/**
 * Patches a pg module so connect is no-op and query uses matcher. Idempotent.
 * Exported so init can call it from a require hook and patch whichever module first requires 'pg' (Task 16.3.1).
 */
export function applyPostgresReplay(pg: { Client: { prototype: Record<string, unknown> } }): void {
  const existingQuery = pg.Client.prototype.query as { [SOFTPROBE_WRAPPED_MARKER]?: boolean };
  if (existingQuery[SOFTPROBE_WRAPPED_MARKER]) return;

  const connectKey = 'connect' as const;
  const existingConnect = pg.Client.prototype[connectKey] as { __softprobeConnect?: boolean };
  if (typeof pg.Client.prototype[connectKey] === 'function' && !existingConnect?.__softprobeConnect) {
    const origConnect = pg.Client.prototype[connectKey] as (...args: unknown[]) => unknown;
    // Use Object.defineProperty (NOT shimmer.wrap) so OTel does NOT detect __wrapped and strip us.
    // OTel's isWrapped() checks __wrapped; without it, OTel wraps our function instead of
    // replacing it. Call chain: OTel wrapper → our wrapper → original connect.
    const patchedConnect = function wrappedConnect(this: unknown, ...args: unknown[]): unknown {
      if (SoftprobeContext.getMode() === 'REPLAY') return Promise.resolve();
      return origConnect.apply(this, args);
    };
    (patchedConnect as unknown as { __softprobeConnect: boolean }).__softprobeConnect = true;
    Object.defineProperty(pg.Client.prototype, connectKey, {
      configurable: true,
      writable: true,
      value: patchedConnect,
    });
  }
  // end() must not touch the network when we never connected (Task 16.3.1). OTel does not wrap
  // end(), so shimmer is safe here.
  const endKey = 'end' as const;
  const existingEnd = pg.Client.prototype[endKey] as { __softprobeEndNoop?: boolean };
  if (typeof pg.Client.prototype[endKey] === 'function' && !existingEnd?.__softprobeEndNoop) {
    shimmer.wrap(
      pg.Client.prototype,
      endKey,
      (originalEnd: (...args: unknown[]) => unknown) =>
        function wrappedEnd(this: unknown, ...args: unknown[]): unknown {
          if (SoftprobeContext.getMode() === 'REPLAY') return Promise.resolve();
          return (originalEnd as (...a: unknown[]) => unknown).apply(this, args);
        }
    );
    (pg.Client.prototype[endKey] as { __softprobeEndNoop?: boolean }).__softprobeEndNoop = true;
  }

  // Use Object.defineProperty (NOT shimmer.wrap) so OTel does NOT detect __wrapped and strip us.
  // OTel wraps our patchedQuery with its span-creating wrapper; our wrapper stays in the chain.
  // Call chain: OTel query wrapper → our patchedQuery → original query.
  const origQuery = pg.Client.prototype.query as (...args: unknown[]) => unknown;
  const patchedQuery = function wrappedQuery(this: unknown, ...args: unknown[]): unknown {
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
  };
  (patchedQuery as unknown as Record<string, unknown>)[SOFTPROBE_WRAPPED_MARKER] = true;
  Object.defineProperty(pg.Client.prototype, 'query', {
    configurable: true,
    writable: true,
    value: patchedQuery,
  });
}

/**
 * Sets up Postgres replay. Called from init so patches are in place before OTel.
 * Idempotent when already applied. OTel may wrap on top when sdk.start() runs.
 */
export function setupPostgresReplay(): void {
  const pg = require('pg');
  const existingQuery = pg.Client.prototype.query as {
    __wrapped?: boolean;
    [SOFTPROBE_WRAPPED_MARKER]?: boolean;
  };
  if (existingQuery[SOFTPROBE_WRAPPED_MARKER]) return;
  applyPostgresReplay(pg);
}
