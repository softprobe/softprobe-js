import { ROOT_CONTEXT, context } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { SoftprobeContext } from '../../context';
import { resolveRequestStorage } from './request-storage';

type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * Resolves request storage using shared priority:
 * 1) existing scoped cassette on current OTel context
 * 2) globally configured cassette on ROOT_CONTEXT
 * 3) global cassetteDirectory + traceId (Task 13.11: per-trace files from config)
 */
export function resolveRequestStorageForContext(
  _headers: HeaderMap | undefined,
  otelContext: Context = context.active(),
  /** Request traceId; when set with global cassetteDirectory, yields per-trace cassette. */
  traceId?: string
): ReturnType<typeof resolveRequestStorage> {
  const cassetteDirectory = SoftprobeContext.getCassetteDirectory(ROOT_CONTEXT);
  return resolveRequestStorage({
    existingCassette: SoftprobeContext.getScopedCassette(otelContext),
    configuredCassette: SoftprobeContext.getCassette(ROOT_CONTEXT),
    cassetteDirectory,
    traceId,
  });
}
