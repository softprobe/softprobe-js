/**
 * Fastify plugin for Softprobe: CAPTURE uses onSend; REPLAY uses preHandler to prime matcher.
 * Design §16.2: CAPTURE → onSend; REPLAY → preHandler primes SoftprobeMatcher by traceId.
 */

import type { FastifyInstance } from 'fastify';
import { trace } from '@opentelemetry/api';
import { CaptureEngine } from './express';
import { softprobeFastifyReplayPreHandler } from '../replay/fastify';

/**
 * Environment-aware Fastify plugin. In CAPTURE mode adds onSend; in REPLAY mode
 * adds preHandler to prime the matcher with records for the active OTel traceId.
 */
export async function softprobeFastifyPlugin(fastify: FastifyInstance): Promise<void> {
  if (process.env.SOFTPROBE_MODE === 'REPLAY') {
    fastify.addHook('preHandler', softprobeFastifyReplayPreHandler);
  }
  if (process.env.SOFTPROBE_MODE === 'CAPTURE') {
    fastify.addHook('onSend', async (request, reply, payload) => {
      const span = trace.getActiveSpan();
      const traceId = span?.spanContext().traceId ?? '';
      // payload is the serialized response (string/Buffer) that will be sent
      CaptureEngine.queueInboundResponse(traceId, {
        status: reply.statusCode,
        body: payload,
        identifier: `${request.method} ${request.url}`,
      });
      return payload;
    });
  }
}
