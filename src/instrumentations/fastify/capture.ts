/**
 * Fastify plugin for Softprobe: CAPTURE uses onSend; REPLAY uses preHandler to prime matcher.
 * Design §16.2: CAPTURE → onSend; REPLAY → preHandler primes SoftprobeMatcher by traceId.
 * Task 17.3.2: Set OTel softprobe context in onRequest so downstream SoftprobeContext works.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { context, trace } from '@opentelemetry/api';
import { CaptureEngine } from '../common/http/inbound-capture';
import { softprobeFastifyReplayPreHandler } from './replay';
import { SoftprobeContext } from '../../context';
import { resolveRequestStorageForContext } from '../../core/cassette/context-request-storage';

/**
 * onRequest hook: run the rest of the request pipeline in an OTel context that has
 * softprobe traceId/mode/storage so SoftprobeContext works in route handlers.
 * Does not return until the response is finished so OTel context stays active for MSW/fetch.
 */
function softprobeFastifyOnRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  next: (err?: Error) => void
): void {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  const base = SoftprobeContext.active();
  const withTrace = { ...base, traceId };
  const softprobeValue = SoftprobeContext.fromHeaders(withTrace, request.headers as Record<string, string | string[] | undefined>);
  const activeCtx = context.active();
  const ctxWithSoftprobe = SoftprobeContext.withData(activeCtx, softprobeValue);
  const runMode = SoftprobeContext.getMode(ctxWithSoftprobe);
  const runTraceId = SoftprobeContext.getTraceId(ctxWithSoftprobe);
  const { storage } = resolveRequestStorageForContext(
    request.headers as Record<string, string | string[] | undefined>,
    activeCtx,
    runTraceId
  );

  const promise = context.with(ctxWithSoftprobe, () =>
    SoftprobeContext.run(
      { mode: runMode, traceId: runTraceId, storage },
      async () => {
        next();
        await new Promise<void>((resolve) => {
          reply.raw.once('finish', resolve);
        });
      }
    )
  );
  void Promise.resolve(promise).catch((err: unknown) => {
    next(err as Error);
  });
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
