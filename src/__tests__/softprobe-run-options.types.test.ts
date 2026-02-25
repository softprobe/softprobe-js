/**
 * Task 1.3 type test: SoftprobeRunOptions enforces required run fields and optional matcher.
 */
import type {
  SoftprobeRunOptions,
  SoftprobeMode,
  Cassette,
  MatcherFn,
} from '../types/schema';

describe('SoftprobeRunOptions', () => {
  const cassette: Cassette = {
    loadTrace: async () => [],
    saveRecord: async () => {},
  };

  it('requires mode, storage, and traceId', () => {
    const baseOptions: SoftprobeRunOptions = {
      mode: 'CAPTURE',
      storage: cassette,
      traceId: 't1',
    };
    expect(baseOptions.mode).toBe('CAPTURE');
    expect(baseOptions.storage).toBe(cassette);
    expect(baseOptions.traceId).toBe('t1');

    // @ts-expect-error missing mode
    const missingMode: SoftprobeRunOptions = {
      storage: cassette,
      traceId: 't1',
    };
    expect(missingMode.traceId).toBe('t1');

    // @ts-expect-error missing storage
    const missingStorage: SoftprobeRunOptions = {
      mode: 'REPLAY',
      traceId: 't2',
    };
    expect(missingStorage.mode).toBe('REPLAY');

    // @ts-expect-error missing traceId
    const missingTraceId: SoftprobeRunOptions = {
      mode: 'PASSTHROUGH',
      storage: cassette,
    };
    expect(missingTraceId.mode).toBe('PASSTHROUGH');
  });

  it('accepts optional matcher with MatcherFn signature', () => {
    const matcher: MatcherFn = () => ({ action: 'CONTINUE' });
    const optsWithMatcher: SoftprobeRunOptions = {
      mode: 'REPLAY',
      storage: cassette,
      traceId: 't2',
      matcher,
    };
    expect(optsWithMatcher.matcher).toBe(matcher);
  });
});
