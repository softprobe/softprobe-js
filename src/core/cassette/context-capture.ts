import { SoftprobeContext } from '../../context';
import type { SoftprobeCassetteRecord } from '../../types/schema';

/**
 * Writes one capture record through the active cassette using active trace context.
 */
export async function saveCaptureRecordFromContext(
  record: SoftprobeCassetteRecord
): Promise<void> {
  if (SoftprobeContext.getMode() !== 'CAPTURE') return;
  const cassette = SoftprobeContext.getCassette();
  if (!cassette) return;
  const traceId = SoftprobeContext.getTraceId();
  await cassette.saveRecord(traceId, record);
}

/**
 * Flushes the active cassette when a flush hook is available.
 */
export async function flushCaptureFromContext(): Promise<void> {
  const cassette = SoftprobeContext.getCassette();
  await cassette?.flush?.();
}
