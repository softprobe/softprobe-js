import type {
  CapturedHttpPayload,
  JsonValue,
  OutboundHttpCall,
  SpanId,
  TraceId,
} from "../types.js";

export interface ServerEntrySummary {
  readonly spanId: SpanId;
  readonly serviceName: string;
  readonly method?: string;
  readonly routeOrPath?: string;
  readonly status?: number;
  readonly durationMs: number;
}

export type TracePollSnapshot =
  | {
      readonly traceId: TraceId;
      readonly state: "awaiting_server_span";
    }
  | {
      readonly traceId: TraceId;
      readonly state: "ingested";
      readonly serverEntry: ServerEntrySummary;
      readonly outboundHttp: readonly OutboundHttpCall[];
    };

export interface TraceSink {
  readonly kind: "blackbox" | "arex";
  readonly sinkUrl: string;
  buildExplorerTraceUrl(traceId: TraceId): string | undefined;
  fetchTrace(traceId: TraceId, signal: AbortSignal): Promise<TracePollSnapshot>;
}

export function stripSpJsonPrefix(raw: string): string {
  const trimmedStart = raw.trimStart();
  if (trimmedStart.startsWith("sp.json:")) {
    return trimmedStart.slice("sp.json:".length);
  }
  return raw;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return false;
    }
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export function parseJsonBodyValue(rawText: string | null): JsonValue | undefined {
  if (rawText === null) return undefined;
  const stripped = stripSpJsonPrefix(rawText).trim();
  if (stripped === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(stripped);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function buildCapturedHttpPayload(input: {
  readonly rawText: string | null | undefined;
  readonly parsedJson?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly explicitStatus?: string | undefined;
}): CapturedHttpPayload {
  const text =
    typeof input.rawText === "string" ? stripSpJsonPrefix(input.rawText) : null;
  const json =
    input.parsedJson !== undefined && isJsonValue(input.parsedJson)
      ? input.parsedJson
      : parseJsonBodyValue(text);
  const headers = input.headers ?? {};

  let captureStatus: CapturedHttpPayload["captureStatus"];
  if (text !== null) {
    captureStatus = text.length > 0 ? "captured" : "empty";
  } else if (json !== undefined) {
    captureStatus = "captured";
  } else if (
    input.explicitStatus === "captured" ||
    input.explicitStatus === "empty" ||
    input.explicitStatus === "omitted"
  ) {
    captureStatus = input.explicitStatus;
  } else {
    captureStatus = "omitted";
  }

  return {
    text,
    json,
    headers,
    captureStatus,
  };
}

export function formatAuthHeader(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const trimmed = token.trim();
  if (!trimmed) return {};
  const value = /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
  return { Authorization: value };
}

export function formatExplorerTraceDeepLink(
  explorerBaseUrl: string | undefined,
  traceId: TraceId,
): string | undefined {
  if (!explorerBaseUrl) return undefined;
  const clean = explorerBaseUrl.trim().replace(/\/+$/, "");
  if (!clean) return undefined;
  return `${clean}/?trace=${encodeURIComponent(traceId)}`;
}

export class SinkHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "SinkHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}
