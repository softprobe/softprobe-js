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
  publicKey: string;
  baseUrl: string;
  /** Defaults to `{baseUrl}/v1/traces`. */
  otlpEndpoint?: string;
  environment?: string;
  userId?: string;
  serviceName?: string;
};

export type WebRecordInitOptions = WebRecordCredentials & {
  /** Correlate with LLM / OpenCode session (`sp.session.id`). */
  sessionId?: string;
  /** Flush interval in ms (minimum 5000). */
  interval?: number;
  /** When true, do not auto-start rrweb. */
  manual?: boolean;
  tags?: Tags;
  replacers?: Record<string, string>;
  /** Soft-disable instead of throwing when credentials are incomplete. Default true. */
  softDisable?: boolean;
  /** rrweb: mask all inputs. Default true for agent IDEs. */
  maskAllInputs?: boolean;
  /** Extra rrweb record options (emit is owned by the SDK). */
  recordOptions?: Record<string, unknown>;
};

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
  record: (opts?: { tags?: Tags }) => RecordingHandle | null;
  stop: () => void;
  setTags: (tags: Tags, override?: boolean) => void;
  /** Switch correlation id (e.g. when OpenCode chat session changes). */
  setSessionId: (sessionId: string) => void | Promise<void>;
  flush: () => Promise<void>;
};
