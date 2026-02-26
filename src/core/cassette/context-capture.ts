import { SoftprobeContext } from '../../context';
import type { SoftprobeCassetteRecord } from '../../types/schema';

/**
 * Writes one capture record through the active cassette using active trace context.
 * When context has a traceId, record.traceId is normalized to it (one file per trace).
 */
export async function saveCaptureRecordFromContext(
  record: SoftprobeCassetteRecord
): Promise<void> {
  if (SoftprobeContext.getMode() !== 'CAPTURE') return;
  const cassette = SoftprobeContext.getCassette();
  if (!cassette) return;
  const ctxTraceId = SoftprobeContext.getTraceId();
  const toSave = ctxTraceId ? { ...record, traceId: ctxTraceId } : record;
  await cassette.saveRecord(toSave);
}

/**
 * Flushes the active cassette when a flush hook is available.
 */
export async function flushCaptureFromContext(): Promise<void> {
  const cassette = SoftprobeContext.getCassette();
  await cassette?.flush?.();
}
