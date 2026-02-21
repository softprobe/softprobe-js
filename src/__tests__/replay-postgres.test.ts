/**
 * Task 5.1: Postgres Replay.
 * Asserts client.query is intercepted, does not hit the network, returns rows
 * from the SemanticMatcher, and throws if the query is unmocked (AC4).
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SemanticMatcher } from '../replay/matcher';
import { softprobe } from '../api';
import { setupPostgresReplay } from '../replay/postgres';

function mockSpan(identifier: string, responseBody: string): ReadableSpan {
  return {
    attributes: {
      'softprobe.protocol': 'postgres',
      'softprobe.identifier': identifier,
      'softprobe.response.body': responseBody,
    },
  } as unknown as ReadableSpan;
}

describe('Postgres Replay (Task 5.1)', () => {
  beforeAll(() => {
    setupPostgresReplay();
  });

  afterEach(() => {
    softprobe.clearReplayContext();
  });

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
    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [], rowCount: 0 })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { Client } = require('pg');
    const client = new Client();

    await expect(client.query('SELECT other')).rejects.toThrow(
      /\[Softprobe\] No recorded traces found for postgres: SELECT other/
    );
  });
});
