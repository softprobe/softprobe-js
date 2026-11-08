/** Browser session metadata tags collected from UA / viewport. */
export type SystemInfo = {
  _sp_ua: string;
  _sp_url: string;
  _sp_search: string;
  _sp_referer: string | null;
  _sp_os: string;
  _sp_osVersion: string;
  _sp_browser: string;
  _sp_browserVersion: string;
  _sp_cpu: string;
  _sp_device: string;
  _sp_width: number;
  _sp_height: number;
  _sp_scrollWidth: number;
  _sp_scrollHeight: number;
  _sp_vid: string;
};

export type Tags = {
  userId?: string;
  clientId?: string;
  email?: string;
  phoneNo?: string;
  [key: string]: string | undefined;
};

export type WebRecordCredentials = {
  /** Existing Agent-owned ingest-only API key. */
  apiKey?: string;
  /** @deprecated Use apiKey for Agent-owned ingest keys. */
  publicKey?: string;
  baseUrl: string;
  /** Defaults to `{baseUrl}/v1/traces`. */
  otlpEndpoint?: string;
  environment?: string;
  userId?: string;
  serviceName?: string;
};

export type HttpBodyCaptureRoute = {
  /**
   * Exact HTTP(S) origin already listed in `apiOrigins`.
   * Omit when `apiOrigins` contains exactly one origin.
   */
  origin?: string;
  method: string;
  /** Exact URL path without query string or fragment. */
  path: string;
  /** JSONPath property paths such as `$.paymentDetails.cardNumber`. */
  redactJsonPaths?: string[];
};

export type HttpBodyCaptureOptions = {
  /** Bodies larger than this many bytes are omitted. Defaults to 64 KiB. */
  maxBodyBytes?: number;
  /** Only listed JSON routes can export body content. */
  routes: HttpBodyCaptureRoute[];
};

export type WebRecordInitOptions = Omit<WebRecordCredentials, "baseUrl"> & {
  /**
   * Ingest API root. Omit for https://explorer.softprobe.ai/api/thelake.
   * Local and staging callers pass their own root. A blank value still disables init.
   */
  baseUrl?: string;
  /** Correlate with LLM / OpenCode session (`sp.session.id`). */
  sessionId?: string;
  /** Flush interval in ms (minimum 5000). */
  interval?: number;
  /** Exact HTTP(S) origins to trace and allow to receive W3C trace headers. */
  apiOrigins?: string[];
  /** Opt-in JSON body capture for exact routes. Disabled when omitted. */
  httpBodyCapture?: HttpBodyCaptureOptions;
  /** When true, do not auto-start rrweb. */
  manual?: boolean;
  tags?: Tags;
  replacers?: Record<string, string>;
  /** Soft-disable instead of throwing when credentials are incomplete. Default true. */
  softDisable?: boolean;
  /** rrweb: mask all inputs. Default true for agent IDEs. */
  maskAllInputs?: boolean;
  /** CSS selector for visible text that rrweb should mask. */
  maskTextSelector?: string;
  /** CSS selector for page regions that rrweb should block from recording. */
  blockSelector?: string;
  /** Receives best-effort recording upload state changes. */
  onUploadStatus?: (status: RecordingUploadStatus) => void;
  /** Extra rrweb record options (emit is owned by the SDK). */
  recordOptions?: Record<string, unknown>;
};

export type RecordingUploadStatus = "idle" | "pending" | "uploaded" | "failed" | "incomplete";

export type CompressedRrwebEvent = {
  type: number;
  data: string;
  timestamp: number;
  isCompressed: true;
  eventIndex?: number;
};

export type RrwebEventBatchItem = Record<string, unknown> & {
  type: number;
  timestamp: number;
  eventIndex?: number;
  isCompressed?: boolean;
};

export type RecordingHandle = {
  stop: () => void;
};

export type WebRecordController = {
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly uploadStatus: RecordingUploadStatus;
  record: (opts?: { tags?: Tags }) => RecordingHandle | null;
  stop: () => void;
  setTags: (tags: Tags, override?: boolean) => void;
  /** Switch correlation id (e.g. when OpenCode chat session changes). */
  setSessionId: (sessionId: string) => void | Promise<void>;
  flush: () => Promise<boolean>;
};
