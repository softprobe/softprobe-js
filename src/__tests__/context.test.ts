/**
 * Tests for context.ts: SoftprobeContext API (SOFTPROBE_CONTEXT_DESIGN.md).
 * Getters, withData, initGlobal, fromHeaders, setGlobalReplayMatcher, run.
 */

import * as otelApi from '@opentelemetry/api';
import { ROOT_CONTEXT, context } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import * as path from 'path';
import * as os from 'os';
import { SoftprobeContext, SOFTPROBE_CONTEXT_KEY } from '../context';
import type { SoftprobeMatcher } from '../replay/softprobe-matcher';

describe('context (SoftprobeContext)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  beforeEach(() => {
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', cassettePath: '', strictReplay: false, strictComparison: false });
    SoftprobeContext.setGlobalReplayMatcher(undefined);
  });

  describe('SOFTPROBE_CONTEXT_KEY', () => {
    it('is defined for tests that assert on context.getValue(SOFTPROBE_CONTEXT_KEY)', () => {
      expect(SOFTPROBE_CONTEXT_KEY).toBeDefined();
    });
  });

  describe('active', () => {
    it('returns value from OTel context when set', () => {
      const data = { mode: 'REPLAY' as const, cassettePath: '/c.ndjson', traceId: 't1' };
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, data);
      const active = SoftprobeContext.active(ctx);
      expect(active).toBeDefined();
      expect(SoftprobeContext.getMode(ctx)).toBe('REPLAY');
      expect(SoftprobeContext.getCassettePath(ctx)).toBe('/c.ndjson');
      expect(SoftprobeContext.getTraceId(ctx)).toBe('t1');
    });

    it('returns global default when context has no value', () => {
      SoftprobeContext.initGlobal({ mode: 'REPLAY', cassettePath: '/global.ndjson' });
      expect(SoftprobeContext.getMode(ROOT_CONTEXT)).toBe('REPLAY');
      expect(SoftprobeContext.getCassettePath(ROOT_CONTEXT)).toBe('/global.ndjson');
    });
  });

  describe('getters', () => {
    it('getTraceId, getMode, getCassettePath, getStrictReplay, getStrictComparison return from active state', () => {
      const data = {
        mode: 'CAPTURE' as const,
        cassettePath: '/cap.ndjson',
        traceId: 'trace-1',
        strictReplay: true,
        strictComparison: true,
      };
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, data);
      expect(SoftprobeContext.getTraceId(ctx)).toBe('trace-1');
      expect(SoftprobeContext.getMode(ctx)).toBe('CAPTURE');
      expect(SoftprobeContext.getCassettePath(ctx)).toBe('/cap.ndjson');
      expect(SoftprobeContext.getStrictReplay(ctx)).toBe(true);
      expect(SoftprobeContext.getStrictComparison(ctx)).toBe(true);
    });

    it('getMatcher returns matcher from context when set', () => {
      const matcher = {} as SoftprobeMatcher;
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, {
        mode: 'REPLAY',
        cassettePath: '',
        matcher,
      });
      expect(SoftprobeContext.getMatcher(ctx)).toBe(matcher);
    });

    it('getInboundRecord returns inboundRecord from context when set', () => {
      const record: import('../types/schema').SoftprobeCassetteRecord = {
        version: '4.1',
        type: 'inbound',
        traceId: 't1',
        spanId: 's1',
        timestamp: '0',
        protocol: 'http',
        identifier: 'GET /',
      };
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, {
        mode: 'REPLAY',
        cassettePath: '',
        inboundRecord: record,
      });
      expect(SoftprobeContext.getInboundRecord(ctx)).toEqual(record);
    });
  });

  describe('withData', () => {
    it('returns new context with data and does not mutate original context', () => {
      const value = { mode: 'REPLAY' as const, cassettePath: '/c.ndjson' };
      const newCtx = SoftprobeContext.withData(ROOT_CONTEXT, value);
      expect(newCtx.getValue(SOFTPROBE_CONTEXT_KEY)).toEqual(
        expect.objectContaining({ mode: 'REPLAY', cassettePath: '/c.ndjson' })
      );
      expect(ROOT_CONTEXT.getValue(SOFTPROBE_CONTEXT_KEY)).toBeUndefined();
    });
  });

  describe('initGlobal', () => {
    it('seeds global default used when context is empty', () => {
      SoftprobeContext.initGlobal({
        mode: 'REPLAY',
        cassettePath: '/boot.ndjson',
        strictReplay: true,
        strictComparison: true,
      });
      expect(SoftprobeContext.getMode(ROOT_CONTEXT)).toBe('REPLAY');
      expect(SoftprobeContext.getCassettePath(ROOT_CONTEXT)).toBe('/boot.ndjson');
      expect(SoftprobeContext.getStrictReplay(ROOT_CONTEXT)).toBe(true);
      expect(SoftprobeContext.getStrictComparison(ROOT_CONTEXT)).toBe(true);
    });
  });

  describe('fromHeaders', () => {
    it('applies coordination header overrides over base', () => {
      const base = { mode: 'PASSTHROUGH' as const, cassettePath: '/base.ndjson' };
      const headers: Record<string, string | string[] | undefined> = {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': 'header-trace',
        'x-softprobe-cassette-path': '/header.ndjson',
      };
      const result = SoftprobeContext.fromHeaders(base, headers);
      expect(result.mode).toBe('REPLAY');
      expect(result.traceId).toBe('header-trace');
      expect(result.cassettePath).toBe('/header.ndjson');
    });
  });

  describe('setGlobalReplayMatcher / getMatcher fallback', () => {
    it('getMatcher returns global matcher when mode is REPLAY and context has no matcher', () => {
      const globalMatcher = {} as SoftprobeMatcher;
      SoftprobeContext.setGlobalReplayMatcher(globalMatcher);
      SoftprobeContext.initGlobal({ mode: 'REPLAY', cassettePath: '' });
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, { mode: 'REPLAY', cassettePath: '' });
      expect(SoftprobeContext.getMatcher(ctx)).toBe(globalMatcher);
    });

    it('getMatcher prefers context matcher over global', () => {
      const globalMatcher = {} as SoftprobeMatcher;
      const contextMatcher = {} as SoftprobeMatcher;
      SoftprobeContext.setGlobalReplayMatcher(globalMatcher);
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, {
        mode: 'REPLAY',
        cassettePath: '',
        matcher: contextMatcher,
      });
      expect(SoftprobeContext.getMatcher(ctx)).toBe(contextMatcher);
    });
  });

  describe('run', () => {
    it('runs fn in OTel context with merged partial over active/global', async () => {
      SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', cassettePath: '/global.ndjson' });
      let seenTraceId: string | undefined;
      let seenMode: string | undefined;
      await SoftprobeContext.run(
        { traceId: 'run-trace', mode: 'REPLAY' },
        () => {
          seenTraceId = SoftprobeContext.getTraceId();
          seenMode = SoftprobeContext.getMode();
        }
      );
      expect(seenTraceId).toBe('run-trace');
      expect(seenMode).toBe('REPLAY');
    });

    it('when partial.cassettePath is set, loads NDJSON and sets matcher + inboundRecord', async () => {
      const tmpPath = path.join(os.tmpdir(), `softprobe-context-run-${Date.now()}.ndjson`);
      const fs = await import('fs/promises');
      await fs.writeFile(
        tmpPath,
        [
          JSON.stringify({ version: '4.1', traceId: 't1', spanId: 's1', type: 'inbound', timestamp: '1', spanName: 'in', protocol: 'http', identifier: 'GET /', responsePayload: { statusCode: 200 } }),
          JSON.stringify({ version: '4.1', traceId: 't1', spanId: 's2', type: 'outbound', timestamp: '2', spanName: 'pg', protocol: 'postgres', identifier: 'SELECT 1' }),
        ].join('\n')
      );
      let matcher: unknown;
      let inbound: unknown;
      await SoftprobeContext.run({ traceId: 't1', cassettePath: tmpPath }, () => {
        matcher = SoftprobeContext.getMatcher();
        inbound = SoftprobeContext.getInboundRecord();
      });
      expect(matcher).toBeDefined();
      expect(inbound).toEqual(expect.objectContaining({ type: 'inbound', spanName: 'in' }));
      await fs.unlink(tmpPath).catch(() => {});
    });
  });
});
