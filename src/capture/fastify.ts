/**
 * Fastify plugin for Softprobe: CAPTURE uses onSend; REPLAY uses preHandler to prime matcher.
 * Design §16.2: CAPTURE → onSend; REPLAY → preHandler primes SoftprobeMatcher by traceId.
 * Task 17.3.2: Set OTel softprobe context in onRequest so downstream SoftprobeContext works.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { context, trace } from '@opentelemetry/api';
import { CaptureEngine } from './express';
import { softprobeFastifyReplayPreHandler } from '../replay/fastify';
import { SoftprobeContext } from '../context';

/**
 * onRequest hook: run the rest of the request pipeline in an OTel context that has
 * softprobe traceId/mode/cassettePath so SoftprobeContext works in route handlers.
 */
function softprobeFastifyOnRequest(
  request: FastifyRequest,
  _reply: FastifyReply,
  next: (err?: Error) => void
): void {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  const base = SoftprobeContext.active();
  const withTrace = { ...base, traceId };
  const softprobeValue = SoftprobeContext.fromHeaders(withTrace, request.headers as Record<string, string | string[] | undefined>);
  const activeCtx = context.active();
  const ctxWithSoftprobe = SoftprobeContext.withData(activeCtx, softprobeValue);
  context.with(ctxWithSoftprobe, next);
}

/**
 * Environment-aware Fastify plugin. In CAPTURE mode adds onSend; in REPLAY mode
 * adds preHandler to prime the matcher with records for the active OTel traceId.
 * Task 17.3.2: Adds onRequest so every request runs in softprobe OTel context.
 */
export async function softprobeFastifyPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', softprobeFastifyOnRequest);
  if (SoftprobeContext.getMode() === 'REPLAY') {
    fastify.addHook('preHandler', softprobeFastifyReplayPreHandler);
  }
  if (SoftprobeContext.getMode() === 'CAPTURE') {
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
