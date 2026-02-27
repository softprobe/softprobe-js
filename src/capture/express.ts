/**
 * Legacy compatibility re-export for Express capture instrumentation.
 */
export {
  CaptureEngine,
  queueInboundResponse,
  softprobeExpressMiddleware,
} from '../instrumentations/express/capture';
export type { QueueInboundResponsePayload } from '../instrumentations/express/capture';
