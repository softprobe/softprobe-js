/**
 * Fastify instrumentation package entry point.
 */
export { normalizeHeaderMap } from '../../instrumentations/common/http/context-headers';
export { softprobeFastifyPlugin } from './capture';
export { softprobeFastifyReplayPreHandler } from './replay';
