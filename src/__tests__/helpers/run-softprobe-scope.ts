import { context } from '@opentelemetry/api';
import { SoftprobeContext } from '../../context';
import { loadReplayRecordsFromPath } from '../../replay/store-accessor';
import type { SemanticMatcher } from '../../replay/matcher';
import { SoftprobeMatcher } from '../../replay/softprobe-matcher';
import type { Cassette, SoftprobeCassetteRecord, SoftprobeMode } from '../../types/schema';

type ScopeOptions = {
  traceId?: string;
  cassettePath?: string;
  mode?: SoftprobeMode;
  strictReplay?: boolean;
  strictComparison?: boolean;
  matcher?: SemanticMatcher | SoftprobeMatcher;
  inboundRecord?: SoftprobeCassetteRecord;
};

const noOpCassette: Cassette = {
  loadTrace: async () => [],
  saveRecord: async () => {},
};

/**
 * Test helper to run code inside a Softprobe scope using the canonical run(options, fn) API.
 */
export function runSoftprobeScope<T>(
  scope: ScopeOptions,
  fn: () => T | Promise<T>
): T | Promise<T> {
  let loadedRecords: SoftprobeCassetteRecord[] = [];
  const hasExplicitTraceId = Boolean(scope.traceId);
  const replayStorage: Cassette | undefined = scope.cassettePath
    ? {
        loadTrace: async (traceId: string) => {
          const records = await loadReplayRecordsFromPath(scope.cassettePath as string);
          loadedRecords =
            hasExplicitTraceId && traceId
              ? records.filter((r) => r.traceId === traceId)
              : records;
          return loadedRecords;
        },
        saveRecord: async () => {},
      }
    : undefined;

  return SoftprobeContext.run(
    {
      mode: scope.mode ?? (scope.cassettePath || scope.matcher ? 'REPLAY' : 'PASSTHROUGH'),
      storage: replayStorage ?? noOpCassette,
      traceId: scope.traceId ?? '',
    },
    () => {
      const active = SoftprobeContext.active();
      const inboundRecord = loadedRecords.find((r) => r.type === 'inbound');
      const patched = SoftprobeContext.withData(context.active(), {
        ...active,
        mode: scope.mode ?? active.mode,
        traceId: scope.traceId ?? active.traceId,
        cassettePath: scope.cassettePath ?? active.cassettePath,
        strictReplay: scope.strictReplay ?? active.strictReplay,
        strictComparison: scope.strictComparison ?? active.strictComparison,
        matcher: scope.matcher ?? active.matcher,
        inboundRecord: scope.inboundRecord ?? inboundRecord ?? active.inboundRecord,
      });
      return context.with(patched, fn);
    }
  );
}
