/**
 * Tests for context.ts: SoftprobeContext API (design-context.md).
 * Getters, withData, initGlobal, fromHeaders, setGlobalReplayMatcher, run.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import * as otelApi from '@opentelemetry/api';
import { ROOT_CONTEXT, context } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { SoftprobeContext, SOFTPROBE_CONTEXT_KEY } from '../context';
import type { SoftprobeMatcher } from '../replay/softprobe-matcher';
import type { Cassette } from '../types/schema';

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

  describe('Task 5.3: remove cassettePath from SoftprobeContext runtime/public API', () => {
    it('does not expose getCassettePath on the public SoftprobeContext API', () => {
      const api = SoftprobeContext as unknown as Record<string, unknown>;
      expect(api.getCassettePath).toBeUndefined();
    });

    it('fromHeaders does not add cassettePath to runtime context state', () => {
      const base = { mode: 'PASSTHROUGH' as const };
      const headers: Record<string, string | string[] | undefined> = {
        'x-softprobe-cassette-path': '/header.ndjson',
      };
      const result = SoftprobeContext.fromHeaders(base as any, headers);
      expect((result as unknown as Record<string, unknown>).cassettePath).toBeUndefined();
    });
  });

  describe('active', () => {
    it('returns value from OTel context when set', () => {
      const data = { mode: 'REPLAY' as const, traceId: 't1' };
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, data);
      const active = SoftprobeContext.active(ctx);
      expect(active).toBeDefined();
      expect(SoftprobeContext.getMode(ctx)).toBe('REPLAY');
      expect(SoftprobeContext.getTraceId(ctx)).toBe('t1');
    });

    it('returns global default when context has no value', () => {
      SoftprobeContext.initGlobal({ mode: 'REPLAY', cassettePath: '/global.ndjson' });
      expect(SoftprobeContext.getMode(ROOT_CONTEXT)).toBe('REPLAY');
    });

    it('exposes storage when provided in context', () => {
      const cassette: Cassette = {
        loadTrace: async () => [],
        saveRecord: async () => {},
      };
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, {
        mode: 'CAPTURE',
        traceId: 'trace-storage',
        storage: cassette,
      });
      const active = SoftprobeContext.active(ctx);
      expect(active.storage).toBe(cassette);
    });
  });

  describe('getters', () => {
    it('getTraceId, getMode, getStrictReplay, getStrictComparison return from active state', () => {
      const data = {
        mode: 'CAPTURE' as const,
        traceId: 'trace-1',
        strictReplay: true,
        strictComparison: true,
      };
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, data);
      expect(SoftprobeContext.getTraceId(ctx)).toBe('trace-1');
      expect(SoftprobeContext.getMode(ctx)).toBe('CAPTURE');
      expect(SoftprobeContext.getStrictReplay(ctx)).toBe(true);
      expect(SoftprobeContext.getStrictComparison(ctx)).toBe(true);
    });

    it('getMatcher returns matcher from context when set', () => {
      const matcher = {} as SoftprobeMatcher;
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, {
        mode: 'REPLAY',
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
        inboundRecord: record,
      });
      expect(SoftprobeContext.getInboundRecord(ctx)).toEqual(record);
    });

    it('getCassette returns cassette from context when set via withData', () => {
      const cassette: Cassette = {
        loadTrace: async () => [],
        saveRecord: async () => {},
      };
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, {
        mode: 'CAPTURE',
        storage: cassette,
      });
      expect(SoftprobeContext.getCassette(ctx)).toBe(cassette);
    });
  });

  describe('withData', () => {
    it('returns new context with data and does not mutate original context', () => {
      const value = { mode: 'REPLAY' as const, traceId: 't1' };
      const newCtx = SoftprobeContext.withData(ROOT_CONTEXT, value);
      expect(newCtx.getValue(SOFTPROBE_CONTEXT_KEY)).toEqual(
        expect.objectContaining({ mode: 'REPLAY', traceId: 't1' })
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
      expect(SoftprobeContext.getStrictReplay(ROOT_CONTEXT)).toBe(true);
      expect(SoftprobeContext.getStrictComparison(ROOT_CONTEXT)).toBe(true);
    });
  });

  describe('fromHeaders', () => {
    it('applies coordination header overrides over base', () => {
      const base = { mode: 'PASSTHROUGH' as const };
      const headers: Record<string, string | string[] | undefined> = {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': 'header-trace',
        'x-softprobe-cassette-path': '/header.ndjson',
      };
      const result = SoftprobeContext.fromHeaders(base, headers);
      expect(result.mode).toBe('REPLAY');
      expect(result.traceId).toBe('header-trace');
      expect((result as unknown as Record<string, unknown>).cassettePath).toBeUndefined();
    });
  });

  describe('Task 7.3: remove global replay matcher fallback path', () => {
    it('getMatcher does not return global matcher when context has no matcher', () => {
      const globalMatcher = {} as SoftprobeMatcher;
      SoftprobeContext.setGlobalReplayMatcher(globalMatcher);
      SoftprobeContext.initGlobal({ mode: 'REPLAY', cassettePath: '' });
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, { mode: 'REPLAY' });
      expect(SoftprobeContext.getMatcher(ctx)).toBeUndefined();
    });

    it('getMatcher returns context matcher when present', () => {
      const globalMatcher = {} as SoftprobeMatcher;
      const contextMatcher = {} as SoftprobeMatcher;
      SoftprobeContext.setGlobalReplayMatcher(globalMatcher);
      const ctx = SoftprobeContext.withData(ROOT_CONTEXT, {
        mode: 'REPLAY',
        matcher: contextMatcher,
      });
      expect(SoftprobeContext.getMatcher(ctx)).toBe(contextMatcher);
    });
  });

  describe('run', () => {
    it('runs fn in OTel context with options and exposes mode, traceId, storage', async () => {
      const cassette: Cassette = {
        loadTrace: async () => [],
        saveRecord: async () => {},
      };
      let seenTraceId: string | undefined;
      let seenMode: string | undefined;
      let seenStorage: Cassette | undefined;
      await SoftprobeContext.run(
        { traceId: 'run-trace', mode: 'REPLAY', storage: cassette },
        () => {
          seenTraceId = SoftprobeContext.getTraceId();
          seenMode = SoftprobeContext.getMode();
          seenStorage = SoftprobeContext.getCassette();
        }
      );
      expect(seenTraceId).toBe('run-trace');
      expect(seenMode).toBe('REPLAY');
      expect(seenStorage).toBe(cassette);
    });

    it('getTraceId is always a non-empty string inside run scope', async () => {
      let seenTraceId = '';
      await SoftprobeContext.run(
        { mode: 'CAPTURE', traceId: '', storage: { loadTrace: async () => [], saveRecord: async () => {} } },
        () => {
          const traceId: string = SoftprobeContext.getTraceId();
          seenTraceId = traceId;
        }
      );
      expect(seenTraceId.length).toBeGreaterThan(0);
    });

    it('getCassette returns same cassette passed via run options', async () => {
      const cassette: Cassette = {
        loadTrace: async () => [],
        saveRecord: async () => {},
      };
      let seen: Cassette | undefined;
      await SoftprobeContext.run(
        { mode: 'CAPTURE', traceId: 'run-cassette', storage: cassette },
        () => {
          seen = SoftprobeContext.getCassette();
        }
      );
      expect(seen).toBe(cassette);
    });

    it('Task 13.3: in REPLAY mode, run calls storage.loadTrace() with no args once per run', async () => {
      const loadTrace = jest.fn(async () => []);
      const cassette: Cassette = {
        loadTrace,
        saveRecord: async () => {},
      };

      await SoftprobeContext.run(
        { mode: 'REPLAY', traceId: 'trace-replay-load', storage: cassette },
        async () => {}
      );

      expect(loadTrace).toHaveBeenCalledTimes(1);
      expect(loadTrace).toHaveBeenCalledWith();
    });

    it('in REPLAY mode, active matcher is seeded with loaded records before callback', async () => {
      const cassetteRecords: import('../types/schema').SoftprobeCassetteRecord[] = [
        {
          version: '4.1',
          traceId: 'trace-seed',
          spanId: 'span-1',
          timestamp: '1',
          type: 'outbound',
          protocol: 'http',
          identifier: 'GET /users',
          responsePayload: { ok: true },
        },
      ];
      const cassette: Cassette = {
        loadTrace: async () => cassetteRecords,
        saveRecord: async () => {},
      };

      let seenRecords = 0;
      await SoftprobeContext.run(
        { mode: 'REPLAY', traceId: 'trace-seed', storage: cassette },
        async () => {
          const matcher = SoftprobeContext.getMatcher() as SoftprobeMatcher | undefined;
          expect(matcher).toBeDefined();
          (matcher as SoftprobeMatcher).use((_span, records) => {
            seenRecords = records.length;
            return { action: 'CONTINUE' };
          });
          (matcher as SoftprobeMatcher).match();
        }
      );

      expect(seenRecords).toBe(cassetteRecords.length);
    });

    it('in CAPTURE mode, run never calls storage.loadTrace', async () => {
      const loadTrace = jest.fn(async () => []);
      const cassette: Cassette = {
        loadTrace,
        saveRecord: async () => {},
      };

      await SoftprobeContext.run(
        { mode: 'CAPTURE', traceId: 'trace-capture-no-read', storage: cassette },
        async () => {}
      );

      expect(loadTrace).not.toHaveBeenCalled();
    });

    /**
     * Task 13.5: get-or-create cassette per traceId; same instance reused for same (cassetteDirectory, traceId).
     */
    describe('Task 13.5: get-or-create cassette per traceId', () => {
      it('returns the same cassette instance for the same traceId and cassetteDirectory across two runs', async () => {
        const cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softprobe-13-5-'));
        try {
          SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });

          let ref1: Cassette | undefined;
          let ref2: Cassette | undefined;
          await SoftprobeContext.run(
            { mode: 'CAPTURE', traceId: 'trace-same' },
            () => {
              ref1 = SoftprobeContext.getCassette();
            }
          );
          await SoftprobeContext.run(
            { mode: 'CAPTURE', traceId: 'trace-same' },
            () => {
              ref2 = SoftprobeContext.getCassette();
            }
          );

          expect(ref1).toBeDefined();
          expect(ref2).toBeDefined();
          expect(ref2).toBe(ref1);
        } finally {
          try {
            fs.rmSync(cassetteDir, { recursive: true });
          } catch {
            /* ignore */
          }
        }
      });

      it('returns a different cassette instance for a different traceId', async () => {
        const cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softprobe-13-5-'));
        try {
          SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });

          let refA: Cassette | undefined;
          let refB: Cassette | undefined;
          await SoftprobeContext.run(
            { mode: 'CAPTURE', traceId: 'trace-a' },
            () => {
              refA = SoftprobeContext.getCassette();
            }
          );
          await SoftprobeContext.run(
            { mode: 'CAPTURE', traceId: 'trace-b' },
            () => {
              refB = SoftprobeContext.getCassette();
            }
          );

          expect(refA).toBeDefined();
          expect(refB).toBeDefined();
          expect(refB).not.toBe(refA);
        } finally {
          try {
            fs.rmSync(cassetteDir, { recursive: true });
          } catch {
            /* ignore */
          }
        }
      });

      it('reuses same cassette when only other context fields (e.g. strictReplay) are updated for same traceId', async () => {
        const cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softprobe-13-5-'));
        try {
          SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });

          let ref1: Cassette | undefined;
          let ref2: Cassette | undefined;
          await SoftprobeContext.run(
            { mode: 'CAPTURE', traceId: 'trace-same' },
            () => {
              ref1 = SoftprobeContext.getCassette();
            }
          );
          await SoftprobeContext.run(
            { mode: 'CAPTURE', traceId: 'trace-same', strictReplay: true },
            () => {
              ref2 = SoftprobeContext.getCassette();
            }
          );

          expect(ref1).toBeDefined();
          expect(ref2).toBe(ref1);
        } finally {
          try {
            fs.rmSync(cassetteDir, { recursive: true });
          } catch {
            /* ignore */
          }
        }
      });
    });
  });
});
