/**
 * Task 17.2.1: SOFTPROBE_CONTEXT_KEY is created using @opentelemetry/api createContextKey.
 * Task 17.2.2: setSoftprobeContext returns a new context containing the value.
 * Task 17.2.3: getSoftprobeContext returns context value or globalDefault.
 */

import * as otelApi from '@opentelemetry/api';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import {
  SOFTPROBE_CONTEXT_KEY,
  setSoftprobeContext,
  getSoftprobeContext,
  initGlobalContext,
} from '../context';

jest.mock('@opentelemetry/api', () => {
  const actual = jest.requireActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    createContextKey: jest.fn((name: string) => actual.createContextKey(name)),
  };
});

describe('SOFTPROBE_CONTEXT_KEY', () => {
  it('is created using createContextKey from @opentelemetry/api', () => {
    expect(otelApi.createContextKey).toHaveBeenCalledWith('softprobe_context');
    expect(SOFTPROBE_CONTEXT_KEY).toBeDefined();
  });
});

describe('setSoftprobeContext', () => {
  it('returns a new context containing the value', () => {
    const value = { mode: 'REPLAY' as const, cassettePath: '/cassettes.ndjson' };
    const newCtx = setSoftprobeContext(ROOT_CONTEXT, value);
    expect(newCtx.getValue(SOFTPROBE_CONTEXT_KEY)).toEqual(value);
    expect(ROOT_CONTEXT.getValue(SOFTPROBE_CONTEXT_KEY)).toBeUndefined();
  });
});

describe('getSoftprobeContext', () => {
  it('returns the value when context has a value', () => {
    const value = { mode: 'REPLAY' as const, cassettePath: '/cassettes.ndjson', traceId: 't1' };
    const ctx = setSoftprobeContext(ROOT_CONTEXT, value);
    expect(getSoftprobeContext(ctx)).toEqual(value);
  });

  it('returns globalDefault when context is empty (bootstrap case)', () => {
    initGlobalContext({ mode: 'REPLAY', cassettePath: './global-cassettes.ndjson' });
    const result = getSoftprobeContext(ROOT_CONTEXT);
    expect(result).toEqual({
      mode: 'REPLAY',
      cassettePath: './global-cassettes.ndjson',
      strictReplay: false,
      strictComparison: false,
    });
  });
});
