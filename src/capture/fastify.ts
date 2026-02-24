/**
 * Fastify plugin for Softprobe: CAPTURE uses onSend; REPLAY uses preHandler to prime matcher.
 * Design §16.2: CAPTURE → onSend; REPLAY → preHandler primes SoftprobeMatcher by traceId.
 * Task 17.3.2: Set OTel softprobe context in onRequest so downstream getSoftprobeContext() works.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { context, trace } from '@opentelemetry/api';
import { CaptureEngine } from './express';
import { softprobeFastifyReplayPreHandler } from '../replay/fastify';
import { getSoftprobeContext, setSoftprobeContext, softprobeValueFromHeaders } from '../context';

/**
 * onRequest hook: run the rest of the request pipeline in an OTel context that has
 * softprobe traceId/mode/cassettePath so getSoftprobeContext() works in route handlers.
 */
function softprobeFastifyOnRequest(
  request: FastifyRequest,
  _reply: FastifyReply,
  next: (err?: Error) => void
): void {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  const base = getSoftprobeContext();
  const withTrace = { ...base, traceId };
  const softprobeValue = softprobeValueFromHeaders(withTrace, request.headers as Record<string, string | string[] | undefined>);
  const activeCtx = context.active();
  const ctxWithSoftprobe = setSoftprobeContext(activeCtx, softprobeValue);
  context.with(ctxWithSoftprobe, next);
}

/**
 * Environment-aware Fastify plugin. In CAPTURE mode adds onSend; in REPLAY mode
 * adds preHandler to prime the matcher with records for the active OTel traceId.
 * Task 17.3.2: Adds onRequest so every request runs in softprobe OTel context.
 */
export async function softprobeFastifyPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', softprobeFastifyOnRequest);
  if (getSoftprobeContext().mode === 'REPLAY') {
    fastify.addHook('preHandler', softprobeFastifyReplayPreHandler);
  }
  if (getSoftprobeContext().mode === 'CAPTURE') {
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
