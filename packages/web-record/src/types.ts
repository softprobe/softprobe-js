import type {
  OtlpExportOptions,
  ResourceAttributes,
} from "@softprobe/tracing";

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
  /** Agent-owned Ingestion Key. */
  ingestionKey?: string;
  /** @deprecated Use `otlp.tracesEndpoint` or `otlp.endpoint`. */
  otlpEndpoint?: string;
  otlp?: OtlpExportOptions;
  resourceAttributes?: ResourceAttributes;
  environment?: string;
  userId?: string;
  serviceName?: string;
};

export type HttpBodyCaptureRoute = {
  /**
   * Exact HTTP(S) origin for a cross-origin route when `path` is relative.
   * Omit for same-origin routes, when `path` is a full HTTP(S) URL, or when `apiOrigins` has one entry.
   */
  origin?: string;
  method: string;
  /** Exact URL path (`/api/...`) or full HTTP(S) URL (`https://api.example.com/api/...`) without query string or fragment. */
  path: string;
  /** JSONPath property paths such as `$.paymentDetails.cardNumber`. */
  redactJsonPaths?: string[];
};

export type HttpBodyCaptureOptions = {
  /** Bodies larger than this many bytes are omitted. Defaults to 64 KiB. */
  maxBodyBytes?: number;
  /** Optional route allowlist. Omit to capture JSON bodies on all traced API origins. */
  routes?: HttpBodyCaptureRoute[];
};

export type InputCaptureMode = "masked" | "secrets-only" | "unmasked";

export type CapturedInputValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "secret"; readonly slot: string }
  | { readonly kind: "redacted"; readonly length: number };

export type SemanticAnchorState = "checked" | "expanded" | "pressed" | "selected";

export type SemanticModifierKey = "Alt" | "Control" | "Meta" | "Shift";

export interface SemanticTarget {
  readonly testId?: string;
  readonly role?: string;
  readonly name?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly text?: string;
  readonly inputPurpose?: string;
  readonly cssSelector?: string;
  readonly within?: string;
  readonly position?: { readonly index: number; readonly of: number };
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly pointOffset?: { readonly fx: number; readonly fy: number };
  readonly framePath?: readonly string[];
  readonly rrwebNodeId?: number;
  readonly states?: readonly SemanticAnchorState[];
  readonly value?: string;
}

export interface CausedHttpTrace {
  readonly traceId: string;
  readonly spanId?: string;
  readonly method: string;
  readonly url: string;
  readonly urlTemplate?: string;
  readonly status?: number;
}

export type SemanticVerb =
  | { readonly name: "navigate"; readonly url: string; readonly trigger: "load" | "pushState" | "popstate" }
  | {
      readonly name: "click" | "dblclick" | "contextmenu" | "hover";
      readonly target: SemanticTarget;
      readonly modifiers?: readonly SemanticModifierKey[];
      readonly point: { readonly x: number; readonly y: number };
    }
  | { readonly name: "fill"; readonly target: SemanticTarget; readonly value: CapturedInputValue; readonly replace: boolean }
  | { readonly name: "select"; readonly target: SemanticTarget; readonly value: CapturedInputValue; readonly optionLabel?: string }
  | { readonly name: "check"; readonly target: SemanticTarget; readonly checked: boolean }
  | { readonly name: "press"; readonly target?: SemanticTarget; readonly key: string; readonly modifiers?: readonly SemanticModifierKey[] }
  | { readonly name: "upload"; readonly target: SemanticTarget; readonly fileNames: readonly string[]; readonly mimeTypes: readonly string[] }
  | { readonly name: "drag"; readonly source: SemanticTarget; readonly destination: SemanticTarget }
  | {
      readonly name: "scroll";
      readonly target?: SemanticTarget;
      readonly direction: "up" | "down" | "left" | "right";
      readonly times: number;
      readonly spansViewport: number;
    }
  | {
      readonly name: "dialog";
      readonly dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
      readonly accepted: boolean;
      readonly promptText?: CapturedInputValue;
    }
  | { readonly name: "resize"; readonly viewport: { readonly width: number; readonly height: number } };

export interface RecordedSemanticAction {
  readonly schemaVersion: "sp-ui-action-1";
  readonly actionIndex: number;
  readonly timestampMs: number;
  readonly startPath: string;
  readonly endPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly verb: SemanticVerb;
  readonly causedTraces: readonly CausedHttpTrace[];
  readonly endAnchors: readonly SemanticTarget[];
  readonly goneAnchors: readonly SemanticTarget[];
  readonly settleMs: number;
}

export type WebRecordInitOptions = WebRecordCredentials & {
  /** Correlate with LLM / OpenCode session (`sp.session.id`). */
  sessionId?: string;
  /** Flush interval in ms (minimum 5000). */
  interval?: number;
  /**
   * Optional exact HTTP(S) origins to trace and receive W3C trace headers.
   * Defaults to `window.location.origin` plus any origin declared in `httpBodyCapture.routes`.
   */
  apiOrigins?: string[];
  /**
   * JSON body capture for traced API origins. Enabled by default for same-origin JSON requests.
   * Pass `{ routes: [...] }` to restrict to specific routes, or `false` to disable.
   */
  httpBodyCapture?: boolean | HttpBodyCaptureOptions;
  /** When true, do not auto-start rrweb. */
  manual?: boolean;
  tags?: Tags;
  replacers?: Record<string, string>;
  /** Soft-disable instead of throwing when credentials are incomplete. Default true. */
  softDisable?: boolean;
  /** rrweb: mask all inputs. Default true for agent IDEs unless `inputCapture: "secrets-only"` is active. */
  maskAllInputs?: boolean;
  /** Capture live DOM semantic user actions as `softprobe.ui.action` (`sp-ui-action-1`) OTLP spans. Default false. */
  captureSemanticActions?: boolean;
  /** Input value capture policy for semantic actions (and rrweb default when `maskAllInputs` is omitted). */
  inputCapture?: InputCaptureMode;
  /** Maps CSS selectors (e.g. `input[name="apiKey"]`) to named secret slots (e.g. `API_KEY`). */
  secretSlots?: Readonly<Record<string, string>>;
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
