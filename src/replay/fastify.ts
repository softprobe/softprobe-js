/**
 * Fastify replay trigger: preHandler primes the matcher for the current request traceId.
 * Design §16.2: when mode=REPLAY, preHandler calls activateReplayForContext(traceId)
 * so subsequent outbound calls use records matching the active OTel traceId.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { trace } from '@opentelemetry/api';
import { softprobe } from '../api';
import { getSoftprobeContext } from '../context';

/**
 * PreHandler hook that primes the active SoftprobeMatcher with records for the
 * current request's OTel traceId. Register in REPLAY mode so route handlers see
 * the correct cassette records for matching outbound calls.
 */
export async function softprobeFastifyReplayPreHandler(
  _request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  if (getSoftprobeContext().mode === 'REPLAY' && traceId) {
    softprobe.activateReplayForContext(traceId);
  }
}
