export { RecordSdk } from "./sdk.js";
export {
  buildRecordingExport,
  msToUnixNano,
  randomHexId,
  EVENT_NAME,
  EVENTS_ATTR,
  SPAN_NAME,
} from "./otlp.js";
export {
  getSessionIdHeaderName,
  initializeHttpInterceptor,
  updateHttpInterceptorSessionId,
} from "./http-interceptor.js";
export type {
  CompressedRrwebEvent,
  RecordingHandle,
  RrwebEventBatchItem,
  SystemInfo,
  Tags,
  WebRecordController,
  WebRecordCredentials,
  WebRecordInitOptions,
} from "./types.js";
