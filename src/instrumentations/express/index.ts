/**
 * Express instrumentation package entry point.
 */
export { normalizeHeaderMap } from '../../instrumentations/common/http/context-headers';
export { softprobeExpressMiddleware, CaptureEngine, queueInboundResponse } from './capture';
export { activateReplayForContext } from './replay';
