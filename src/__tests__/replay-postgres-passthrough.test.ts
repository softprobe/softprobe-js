/**
 * Task 9.2.5: CONTINUE + DEV passthrough — original query is invoked when no match and strict not set.
 * Uses a mocked pg so we can assert the original query function was called (real pg would hang).
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SemanticMatcher } from '../replay/matcher';
import { softprobe } from '../api';
import { setupPostgresReplay } from '../replay/postgres';

const mockQueryImpl = jest.fn().mockRejectedValue(new Error('pg not connected'));

jest.mock('pg', () => {
  function Client(this: unknown) {}
  (Client as unknown as { prototype: { query: jest.Mock } }).prototype.query = mockQueryImpl;
  return { Client };
});

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
  mockQueryImpl.mockClear();
});

describe('Postgres Replay (Task 9.2.5)', () => {
  it('CONTINUE + DEV passthrough calls original when no match and strict not set', async () => {
    const strict = process.env.SOFTPROBE_STRICT_REPLAY;
    delete process.env.SOFTPROBE_STRICT_REPLAY;

    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [], rowCount: 0 })),
    ]);
    softprobe.setReplayContext({ traceId: 't1', matcher });

    const { Client } = require('pg');
    const client = new Client();

    await client.query('SELECT other').catch(() => {});

    expect(mockQueryImpl).toHaveBeenCalledTimes(1);
    expect(mockQueryImpl).toHaveBeenCalledWith('SELECT other');

    if (strict !== undefined) process.env.SOFTPROBE_STRICT_REPLAY = strict;
  });
});
