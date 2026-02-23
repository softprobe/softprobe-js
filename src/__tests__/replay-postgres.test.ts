/**
 * Task 5.1: Postgres Replay.
 * Asserts client.query is intercepted, does not hit the network, returns rows
 * from the SemanticMatcher, and throws if the query is unmocked (AC4).
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SemanticMatcher } from '../replay/matcher';
import { softprobe } from '../api';
import { setupPostgresReplay } from '../replay/postgres';
import { PostgresSpan } from '../bindings/postgres-span';

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
  setupPostgresReplay();
});

afterEach(() => {
  softprobe.clearReplayContext();
});

describe('Postgres Replay (Task 5.1)', () => {

  it('returns rows from SemanticMatcher and does not hit the network', async () => {
    const recordedRows = [{ one: 1 }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: recordedRows, rowCount: 1 })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { Client } = require('pg');
    const client = new Client();
    const result = await client.query('SELECT 1');

    expect(result.rows).toEqual(recordedRows);
    expect(result.rowCount).toBe(1);
  });

  it('throws when query is unmocked (no recorded span for identifier)', async () => {
    const strict = process.env.SOFTPROBE_STRICT_REPLAY;
    process.env.SOFTPROBE_STRICT_REPLAY = '1';

    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [], rowCount: 0 })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { Client } = require('pg');
    const client = new Client();

    await expect(client.query('SELECT other')).rejects.toThrow(/no match for pg\.query/);

    if (strict !== undefined) process.env.SOFTPROBE_STRICT_REPLAY = strict;
    else delete process.env.SOFTPROBE_STRICT_REPLAY;
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
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { Client } = require('pg');
    const client = new Client();
    await client.query('SELECT 1');

    expect(tagQuerySpy).toHaveBeenCalledWith('SELECT 1', undefined);
    tagQuerySpy.mockRestore();
  });

  it('9.2.2 MOCK path (promise style) returns pg-like result with rows, rowCount, command', async () => {
    const recordedRows = [{ id: 42, name: 'alice' }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT * FROM users', JSON.stringify({ rows: recordedRows, rowCount: 1, command: 'SELECT' })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

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

  it('9.2.3 MOCK path (callback style) query(text, cb): callback receives mocked result async (nextTick)', async () => {
    const recordedRows = [{ x: 1 }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: recordedRows, rowCount: 1 })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

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

  it('9.2.3 MOCK path (callback style) query(text, values, cb): callback receives mocked result', async () => {
    const recordedRows = [{ id: 10 }];
    const matcher = new SemanticMatcher([
      mockSpan('SELECT * FROM t WHERE id = $1', JSON.stringify({ rows: recordedRows, rowCount: 1 })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

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

  it('9.2.4 CONTINUE + STRICT throws when env SOFTPROBE_STRICT_REPLAY=1 and no match', async () => {
    const strict = process.env.SOFTPROBE_STRICT_REPLAY;
    process.env.SOFTPROBE_STRICT_REPLAY = '1';

    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [], rowCount: 0 })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { Client } = require('pg');
    const client = new Client();

    await expect(client.query('SELECT other')).rejects.toThrow(/no match for pg\.query/);

    if (strict !== undefined) process.env.SOFTPROBE_STRICT_REPLAY = strict;
    else delete process.env.SOFTPROBE_STRICT_REPLAY;
  });

});
