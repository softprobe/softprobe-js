import type { WebOptions } from "@e2e-dev/web";
import type { JsonValue } from "@softprobe/tracing";

export type { JsonValue } from "@softprobe/tracing";

export type TraceId = string & { readonly __brand: "TraceId" };
export type SpanId = string & { readonly __brand: "SpanId" };

const TRACE_ID_HEX_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_HEX_PATTERN = /^[0-9a-f]{16}$/;
const ALL_ZEROS_PATTERN = /^0+$/;

export function isTraceId(value: unknown): value is TraceId {
  return (
    typeof value === "string" &&
    TRACE_ID_HEX_PATTERN.test(value) &&
    !ALL_ZEROS_PATTERN.test(value)
  );
}

export function isSpanId(value: unknown): value is SpanId {
  return (
    typeof value === "string" &&
    SPAN_ID_HEX_PATTERN.test(value) &&
    !ALL_ZEROS_PATTERN.test(value)
  );
}

export type SoftprobeStoreMode = "auto" | "blackbox" | "arex";

export type SoftprobeSinkConfig =
  | {
      readonly kind: "blackbox";
      readonly endpoint: string;
      readonly token?: string;
      readonly workspaceId?: string;
      readonly explorerUrl?: string;
    }
  | {
      readonly kind: "arex";
      readonly endpoint: string;
      readonly appId: string;
      readonly token?: string;
      readonly tenantId?: string;
      readonly explorerUrl?: string;
    };

export interface SoftprobeWebOptions extends WebOptions {
  readonly sink?: SoftprobeSinkConfig;
  readonly endpoint?: string;
  readonly token?: string;
  readonly workspaceId?: string;
  readonly tenantId?: string;
  readonly appId?: string;
  readonly store?: SoftprobeStoreMode;
  readonly explorerUrl?: string;
  readonly apiOrigins?: readonly (string | RegExp)[];
  readonly traceTimeoutMs?: number;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly settleMs?: number;
}

export interface BrowserTriggerFilter {
  readonly method?: string;
  readonly path: string | RegExp;
  readonly origin?: string;
}

export type StatusMatcher = number | readonly [number, number];

export interface OutboundHttpQuery {
  readonly triggeredBy: BrowserTriggerFilter;
  readonly method?: string;
  readonly url: string | RegExp;
  readonly status?: StatusMatcher;
  readonly serviceName?: string | RegExp;
  readonly timeoutMs?: number;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ExpectNoOutboundHttpQuery {
  readonly triggeredBy?: BrowserTriggerFilter;
  readonly method?: string;
  readonly url?: string | RegExp;
  readonly status?: StatusMatcher;
  readonly serviceName?: string | RegExp;
  readonly timeoutMs?: number;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly settleMs?: number;
}

export interface CapturedHttpPayload {
  readonly text: string | null;
  readonly json: JsonValue | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly captureStatus: "captured" | "empty" | "omitted";
}

export interface OutboundHttpCall {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentServerSpanId: SpanId;
  readonly serviceName: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly durationMs: number;
  readonly request: CapturedHttpPayload;
  readonly response: CapturedHttpPayload;
  readonly explorerTraceUrl?: string;
}

export interface TraceScope {
  window(fn: () => Promise<void>): Promise<TraceScope>;
  outboundHttp(query: OutboundHttpQuery): Promise<OutboundHttpCall>;
  expectNoOutboundHttp(query?: ExpectNoOutboundHttpQuery): Promise<void>;
}

export interface TraceInstrumentationErrorDetails {
  readonly traceId: TraceId;
  readonly triggerMethod: string;
  readonly triggerPath: string;
  readonly sinkUrl: string;
  readonly timeoutMs: number;
  readonly explorerTraceUrl?: string;
  readonly causeMessage?: string;
}

export class TraceInstrumentationError extends Error {
  readonly code = "TRACE_INSTRUMENTATION_MISSING" as const;
  readonly traceId: TraceId;
  readonly triggerMethod: string;
  readonly triggerPath: string;
  readonly sinkUrl: string;
  readonly timeoutMs: number;
  readonly explorerTraceUrl: string | undefined;

  constructor(details: TraceInstrumentationErrorDetails) {
    const linkSuffix = details.explorerTraceUrl
      ? ` Inspect trace at ${details.explorerTraceUrl}.`
      : "";
    const causeSuffix = details.causeMessage
      ? ` Last sink error was ${details.causeMessage}.`
      : "";
    super(
      `Backend SERVER span for trace ${details.traceId} (${details.triggerMethod} ${details.triggerPath}) did not arrive at ${details.sinkUrl} within ${details.timeoutMs}ms.${linkSuffix}${causeSuffix}`,
    );
    this.name = "TraceInstrumentationError";
    this.traceId = details.traceId;
    this.triggerMethod = details.triggerMethod;
    this.triggerPath = details.triggerPath;
    this.sinkUrl = details.sinkUrl;
    this.timeoutMs = details.timeoutMs;
    this.explorerTraceUrl = details.explorerTraceUrl;
  }
}

export function isTraceInstrumentationError(
  value: unknown,
): value is TraceInstrumentationError {
  return value instanceof TraceInstrumentationError;
}

export interface TraceAssertionErrorDetails {
  readonly message: string;
  readonly traceId?: TraceId;
  readonly observedCalls?: readonly OutboundHttpCall[];
  readonly explorerTraceUrl?: string;
}

export class TraceAssertionError extends Error {
  readonly code = "TRACE_ASSERTION_FAILED" as const;
  readonly traceId: TraceId | undefined;
  readonly observedCalls: readonly OutboundHttpCall[];
  readonly explorerTraceUrl: string | undefined;

  constructor(details: TraceAssertionErrorDetails) {
    super(details.message);
    this.name = "TraceAssertionError";
    this.traceId = details.traceId;
    this.observedCalls = details.observedCalls ?? [];
    this.explorerTraceUrl = details.explorerTraceUrl;
  }
}

export function isTraceAssertionError(
  value: unknown,
): value is TraceAssertionError {
  return value instanceof TraceAssertionError;
}
