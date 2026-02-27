import { httpIdentifier } from '../../../core/identifier';

/**
 * Builds the canonical inbound HTTP identifier used for capture/replay matching.
 * Keeps Express and Fastify inbound capture paths aligned on one shared implementation.
 */
export function buildInboundHttpIdentifier(method: string, url: string): string {
  return httpIdentifier(method, url);
}
