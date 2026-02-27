/**
 * Shared matcher contracts and implementations.
 */
export { SemanticMatcher } from './matcher';
export { SoftprobeMatcher } from './softprobe-matcher';
export {
  CallSeq,
  createDefaultMatcher,
  extractKeyFromSpan,
  filterOutboundCandidates,
  type SpanKey,
} from './extract-key';
export {
  buildBySpanIdIndex,
  createTopologyMatcher,
  filterCandidatesByKey,
  getLiveParentName,
  selectLineagePool,
} from './topology';
export { getRecordsForTrace } from './store-accessor';
