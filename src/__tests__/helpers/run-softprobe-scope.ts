import { context } from '@opentelemetry/api';
import { SoftprobeContext } from '../../context';
import type { SemanticMatcher } from '../../core/matcher/matcher';
import { SoftprobeMatcher } from '../../core/matcher/softprobe-matcher';
import type { Cassette, SoftprobeCassetteRecord, SoftprobeMode } from '../../types/schema';

type ScopeOptions = {
  traceId?: string;
  cassetteDirectory?: string;
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
 * Uses cassetteDirectory + traceId; cassette path is always {cassetteDirectory}/{traceId}.ndjson (Cassette API).
 */
export function runSoftprobeScope<T>(
  scope: ScopeOptions,
  fn: () => T | Promise<T>
): T | Promise<T> {
  let loadedRecords: SoftprobeCassetteRecord[] = [];
  const hasExplicitTraceId = Boolean(scope.traceId);
  const replayStorage: Cassette | undefined =
    scope.cassetteDirectory && scope.traceId
      ? (() => {
          const cassette = SoftprobeContext.getOrCreateCassette(
            scope.cassetteDirectory,
            scope.traceId
          );
          return {
            loadTrace: async () => {
              const records = await cassette.loadTrace();
              loadedRecords =
                hasExplicitTraceId && scope.traceId
                  ? records.filter((r) => r.traceId === scope.traceId)
                  : records;
              return loadedRecords;
            },
            saveRecord: async () => {},
          };
        })()
      : undefined;

  return SoftprobeContext.run(
    {
      mode:
        scope.mode ??
        ((scope.cassetteDirectory && scope.traceId) || scope.matcher ? 'REPLAY' : 'PASSTHROUGH'),
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
        strictReplay: scope.strictReplay ?? active.strictReplay,
        strictComparison: scope.strictComparison ?? active.strictComparison,
        matcher: scope.matcher ?? active.matcher,
        inboundRecord: scope.inboundRecord ?? inboundRecord ?? active.inboundRecord,
      });
      return context.with(patched, fn);
    }
  );
}
