/**
 * Task 5.1: Postgres Replay.
 * Asserts client.query is intercepted, does not hit the network, returns rows
 * from the SemanticMatcher, and throws if the query is unmocked (AC4).
 */

import * as otelApi from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { SemanticMatcher } from '../core/matcher/matcher';
import { softprobe } from '../api';
import { SoftprobeContext } from '../context';
import { setupPostgresReplay } from '../instrumentations/postgres/replay';
import { PostgresSpan } from '../core/bindings/postgres-span';
import { runSoftprobeScope } from './helpers/run-softprobe-scope';

function mockSpan(identifier: string, responseBody: string): ReadableSpan {
  return {
    attributes: {
      'softprobe.protocol': 'postgres',
      'softprobe.identifier': identifier,
      'softprobe.response.body': responseBody,
    },
  } as unknown as ReadableSpan;
}

beforeAll(() => {
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  otelApi.context.setGlobalContextManager(contextManager);
  setupPostgresReplay();
});

describe('Postgres Replay (Task 5.1)', () => {

  it('returns rows from SemanticMatcher and does not hit the network', async () => {
    const recordedRows = [{ one: 1 }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: recordedRows, rowCount: 1 })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();
      const result = await client.query('SELECT 1');
      expect(result.rows).toEqual(recordedRows);
      expect(result.rowCount).toBe(1);
    });
  });

  it('throws when query is unmocked (no recorded span for identifier)', async () => {
    SoftprobeContext.initGlobal({ strictReplay: true });

    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [], rowCount: 0 })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();
      await expect(client.query('SELECT other')).rejects.toThrow(/no match for pg\.query/);
    });

    SoftprobeContext.initGlobal({ strictReplay: false });
  });
});

/**
 * Task 9.2: Postgres replay wrapper.
 * Design §9.1: we support both promise and callback style pg.Client.query APIs.
 */
describe('Postgres Replay (Task 9.2)', () => {
  it('9.2.1 wrapper tags span via PostgresSpan.tagQuery with SQL', async () => {
    const tagQuerySpy = jest.spyOn(PostgresSpan, 'tagQuery').mockImplementation(() => {});

    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [{ one: 1 }], rowCount: 1 })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();
      await client.query('SELECT 1');
      expect(tagQuerySpy).toHaveBeenCalledWith('SELECT 1', undefined, undefined);
    });
    tagQuerySpy.mockRestore();
  });

  it('9.2.2 MOCK path (promise style) returns pg-like result with rows, rowCount, command', async () => {
    const recordedRows = [{ id: 42, name: 'alice' }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT * FROM users', JSON.stringify({ rows: recordedRows, rowCount: 1, command: 'SELECT' })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();
      const result = await client.query('SELECT * FROM users');
      expect(result).toMatchObject({
        rows: recordedRows,
        rowCount: 1,
        command: 'SELECT',
      });
      expect(result).toHaveProperty('rows');
      expect(result).toHaveProperty('rowCount');
      expect(result).toHaveProperty('command');
    });
  });

  it('9.2.3 MOCK path (callback style) query(text, cb): callback receives mocked result async (nextTick)', async () => {
    const recordedRows = [{ x: 1 }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: recordedRows, rowCount: 1 })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();

      const result = await new Promise<{ rows: unknown[]; rowCount: number; command: string }>((resolve, reject) => {
        let sync = true;
        client.query('SELECT 1', (err: Error | null, res?: { rows: unknown[]; rowCount: number; command: string }) => {
          expect(sync).toBe(false);
          if (err) return reject(err);
          resolve(res!);
        });
        sync = false;
      });

      expect(result).toMatchObject({ rows: recordedRows, rowCount: 1, command: 'SELECT' });
    });
  });

  it('9.2.3 MOCK path (callback style) query(text, values, cb): callback receives mocked result', async () => {
    const recordedRows = [{ id: 10 }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT * FROM t WHERE id = $1', JSON.stringify({ rows: recordedRows, rowCount: 1 })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();

      const result = await new Promise<{ rows: unknown[]; rowCount: number; command: string }>((resolve, reject) => {
        client.query('SELECT * FROM t WHERE id = $1', [10], (err: Error | null, res?: { rows: unknown[]; rowCount: number; command: string }) => {
          if (err) return reject(err);
          resolve(res!);
        });
      });

      expect(result).toMatchObject({ rows: recordedRows, rowCount: 1, command: 'SELECT' });
    });
  });

  it('9.2.4 CONTINUE + STRICT throws when strictReplay and no match', async () => {
    SoftprobeContext.initGlobal({ strictReplay: true });

    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [], rowCount: 0 })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();
      await expect(client.query('SELECT other')).rejects.toThrow(/no match for pg\.query/);
    });

    SoftprobeContext.initGlobal({ strictReplay: false });
  });

});

/**
 * Task 18.1.1: Postgres connect() shim uses Context lookup (globalDefault from YAML).
 * When globalDefault mode is REPLAY, connect() must return Promise.resolve() immediately.
 */
describe('Task 18.1.1 Postgres connect() context-lookup', () => {
  it('when globalDefault is REPLAY, client.connect() returns Promise.resolve() immediately', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY' });

    const { Client } = require('pg');
    const client = new Client();

    await expect(client.connect()).resolves.toBeUndefined();

    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH' });
  });
});

/**
 * Task 18.1.2: Postgres query() matcher is pulled from the active OTel context first.
 */
describe('Task 18.1.2 Postgres query() context-matcher', () => {
  const { context } = require('@opentelemetry/api');
  const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');
  const otelApi = require('@opentelemetry/api');
  const { SoftprobeContext } = require('../context');
  const { SoftprobeMatcher } = require('../core/matcher/softprobe-matcher');

  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  it('query matcher is pulled from the active OTel context first', async () => {
    const contextMatcher = new SoftprobeMatcher();
    contextMatcher.use((span: { attributes?: Record<string, unknown> }, _records: unknown) => {
      const attrs = span?.attributes ?? {};
      if (attrs['softprobe.identifier'] === 'SELECT 1') {
        return { action: 'MOCK' as const, payload: { rows: [{ from: 'otel-context' }], rowCount: 1, command: 'SELECT' } };
      }
      return { action: 'CONTINUE' as const };
    });

    const activeCtx = context.active();
    const ctxWithMatcher = SoftprobeContext.withData(activeCtx, {
      mode: 'REPLAY',
      matcher: contextMatcher,
    });

    let queryResult: { rows: unknown[] } | undefined;
    await context.with(ctxWithMatcher, async () => {
      expect(softprobe.getActiveMatcher()).toBe(contextMatcher);

      const { Client } = require('pg');
      const client = new Client();
      queryResult = await client.query('SELECT 1');
    });

    expect(queryResult).toBeDefined();
    expect(queryResult!.rows).toEqual([{ from: 'otel-context' }]);
  });
});
