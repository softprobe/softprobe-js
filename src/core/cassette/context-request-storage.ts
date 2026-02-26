import { ROOT_CONTEXT, context } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { SoftprobeContext } from '../../context';
import { resolveRequestStorage } from './request-storage';

type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * Resolves request storage using shared priority:
 * 1) cassette path header
 * 2) existing scoped cassette on current OTel context
 * 3) globally configured cassette on ROOT_CONTEXT
 */
export function resolveRequestStorageForContext(
  headers: HeaderMap | undefined,
  otelContext: Context = context.active()
): ReturnType<typeof resolveRequestStorage> {
  return resolveRequestStorage({
    headers,
    existingCassette: SoftprobeContext.getScopedCassette(otelContext),
    configuredCassette: SoftprobeContext.getCassette(ROOT_CONTEXT),
  });
}
