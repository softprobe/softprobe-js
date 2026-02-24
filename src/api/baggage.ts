/**
 * Task 15.1.1: Inject softprobe-mode into OTel Baggage for downstream propagation.
 * Design §15.2: when mode=REPLAY, inject so internal microservice calls are also mocked.
 */
import {
  context,
  propagation,
  baggageEntryMetadataFromString,
} from '@opentelemetry/api';
import { getSoftprobeContext } from '../context';

const SOFTPROBE_MODE_KEY = 'softprobe-mode';
const REPLAY_VALUE = 'REPLAY';
const METADATA_STR = 'softprobe';

/**
 * Returns the current OTel context with `softprobe-mode: REPLAY` in baggage when
 * getSoftprobeContext().mode is REPLAY. Otherwise returns the active context unchanged.
 * Middleware (Express/Fastify) should run the request in this context so
 * outbound calls propagate the mode to downstream services.
 */
export function getContextWithReplayBaggage(): ReturnType<typeof context.active> {
  const activeContext = context.active();
  if (getSoftprobeContext().mode !== REPLAY_VALUE) {
    return activeContext;
  }
  const currentBaggage = propagation.getBaggage(activeContext);
  const entry = {
    value: REPLAY_VALUE,
    metadata: baggageEntryMetadataFromString(METADATA_STR),
  };
  const newBaggage = (currentBaggage ?? propagation.createBaggage()).setEntry(
    SOFTPROBE_MODE_KEY,
    entry
  );
  return propagation.setBaggage(activeContext, newBaggage);
}
