/**
 * Express replay trigger: primes the matcher for the current request traceId.
 * Design §16.1: when SOFTPROBE_MODE=REPLAY and traceId is in context, middleware calls this.
 */

import { softprobe } from '../../api';

/**
 * Primes the active Softprobe matcher with records for the given traceId.
 * Called by softprobeExpressMiddleware when SOFTPROBE_MODE=REPLAY so outbound calls use the right cassette.
 */
export function activateReplayForContext(traceId: string): void {
  softprobe.activateReplayForContext(traceId);
}
