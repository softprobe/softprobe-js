/**
 * Task 9.2.5: CONTINUE + DEV passthrough — original query is invoked when no match and strict not set.
 * Uses a mocked pg so we can assert the original query function was called (real pg would hang).
 */

import * as otelApi from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { SemanticMatcher } from '../replay/matcher';
import { SoftprobeMatcher } from '../replay/softprobe-matcher';
import { softprobe } from '../api';
import { SoftprobeContext } from '../context';
import { setupPostgresReplay } from '../replay/postgres';
import { runSoftprobeScope } from './helpers/run-softprobe-scope';

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
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  otelApi.context.setGlobalContextManager(contextManager);
  setupPostgresReplay();
});

afterEach(() => {
  mockQueryImpl.mockClear();
});

describe('Postgres Replay (Task 9.2.5)', () => {
  it('CONTINUE + DEV passthrough calls original when no match and strict not set', async () => {
    SoftprobeContext.initGlobal({ strictReplay: false });

    const matcher = new SemanticMatcher([
      mockSpan('SELECT 1', JSON.stringify({ rows: [], rowCount: 0 })),
    ]);
    await runSoftprobeScope({ traceId: 't1', matcher }, async () => {
      const { Client } = require('pg');
      const client = new Client();
      await client.query('SELECT other').catch(() => {});

      expect(mockQueryImpl).toHaveBeenCalledTimes(1);
      expect(mockQueryImpl).toHaveBeenCalledWith('SELECT other');
    });
  });
});

describe('Task 6.1: Postgres replay wrapper reads matcher from active context only', () => {
  afterEach(() => {
    softprobe.setGlobalReplayMatcher(undefined);
  });

  it('ignores global matcher fallback and uses original query when active context has no matcher', async () => {
    const globalMatcher = new SoftprobeMatcher();
    globalMatcher.use(() => ({
      action: 'MOCK',
      payload: { rows: [{ from: 'global-matcher' }], rowCount: 1, command: 'SELECT' },
    }));
    softprobe.setGlobalReplayMatcher(globalMatcher);

    const activeCtx = otelApi.context.active();
    const replayCtxWithoutMatcher = SoftprobeContext.withData(activeCtx, {
      mode: 'REPLAY',
      traceId: 't-6-1',
    });

    await otelApi.context.with(replayCtxWithoutMatcher, async () => {
      const { Client } = require('pg');
      const client = new Client();
      await client.query('SELECT 1').catch(() => {});
      expect(mockQueryImpl).toHaveBeenCalledTimes(1);
      expect(mockQueryImpl).toHaveBeenCalledWith('SELECT 1');
    });
  });
});

describe('Task 6.4: Wrapper strict/dev behavior remains wrapper-owned (Postgres)', () => {
  afterEach(() => {
    SoftprobeContext.initGlobal({ strictReplay: false });
  });

  it('strict replay hard-fails when no active matcher is available', async () => {
    SoftprobeContext.initGlobal({ strictReplay: true });

    const activeCtx = otelApi.context.active();
    const replayCtxWithoutMatcher = SoftprobeContext.withData(activeCtx, {
      mode: 'REPLAY',
      traceId: 't-6-4-pg',
    });

    await otelApi.context.with(replayCtxWithoutMatcher, async () => {
      const { Client } = require('pg');
      const client = new Client();
      await expect(client.query('SELECT 1')).rejects.toThrow(/no match for pg\.query/);
      expect(mockQueryImpl).not.toHaveBeenCalled();
    });
  });
});
