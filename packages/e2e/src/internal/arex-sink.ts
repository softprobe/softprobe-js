import { z } from "zod";
import {
  isSpanId,
  isTraceId,
  type OutboundHttpCall,
  type SpanId,
  type TraceId,
} from "../types.js";
import {
  buildCapturedHttpPayload,
  formatAuthHeader,
  formatExplorerTraceDeepLink,
  SinkHttpError,
  type TracePollSnapshot,
  type TraceSink,
} from "./sink-shared.js";

const FALLBACK_SERVER_SPAN_ID_HEX = "0000000000000001";

const arexHttpPayloadSchema = z
  .object({
    text: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    json: z.unknown().optional(),
    headers: z.record(z.string(), z.unknown()).nullable().optional(),
    captureStatus: z.enum(["captured", "empty", "omitted"]).optional(),
  })
  .nullable()
  .optional();

const arexServerEntrySchema = z
  .object({
    spanId: z.string().optional(),
    serviceName: z.string().optional(),
    method: z.string().nullable().optional(),
    routeOrPath: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    status: z.number().nullable().optional(),
    durationMs: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const arexOutboundItemSchema = z.object({
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  recordId: z.string().optional(),
  parentServerSpanId: z.string().optional(),
  serviceName: z.string().optional(),
  method: z.string().optional(),
  url: z.string(),
  status: z.number().optional(),
  statusCode: z.number().optional(),
  durationMs: z.number().optional(),
  request: arexHttpPayloadSchema,
  response: arexHttpPayloadSchema,
  explorerTraceUrl: z.string().optional(),
});

const arexTracePayloadSchema = z.object({
  traceId: z.string().optional(),
  state: z.enum(["awaiting_server_span", "ingested"]),
  serverEntry: arexServerEntrySchema,
  outboundHttp: z.array(arexOutboundItemSchema).optional(),
});

const wrappedEnvelopeSchema = z.object({
  body: z.unknown().optional(),
  data: z.unknown().optional(),
});

function coerceOrDeterministicSpanId(candidate: string | undefined, index: number): SpanId {
  const normalized = candidate?.trim().toLowerCase() ?? "";
  if (isSpanId(normalized)) {
    return normalized;
  }
  const deterministic = index.toString(16).padStart(16, "0");
  if (isSpanId(deterministic)) {
    return deterministic;
  }
  if (isSpanId(FALLBACK_SERVER_SPAN_ID_HEX)) {
    return FALLBACK_SERVER_SPAN_ID_HEX;
  }
  throw new Error("Unable to construct valid fallback SpanId");
}

function normalizeStringHeaders(
  raw: Record<string, unknown> | null | undefined,
): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value.map(String).join(", ");
    } else if (typeof value === "number" || typeof value === "boolean") {
      headers[key.toLowerCase()] = String(value);
    }
  }
  return headers;
}

function unwrapArexResponseEnvelope(raw: unknown): unknown {
  const direct = arexTracePayloadSchema.safeParse(raw);
  if (direct.success) return raw;
  const wrapped = wrappedEnvelopeSchema.safeParse(raw);
  if (!wrapped.success) return raw;
  if (wrapped.data.body !== undefined) {
    const innerBody = arexTracePayloadSchema.safeParse(wrapped.data.body);
    if (innerBody.success) return wrapped.data.body;
  }
  if (wrapped.data.data !== undefined) {
    const innerData = arexTracePayloadSchema.safeParse(wrapped.data.data);
    if (innerData.success) return wrapped.data.data;
  }
  return raw;
}

export function parseArexTracePayload(
  traceId: TraceId,
  raw: unknown,
  explorerTraceUrl: string | undefined,
): TracePollSnapshot {
  const unwrapped = unwrapArexResponseEnvelope(raw);
  const parsed = arexTracePayloadSchema.safeParse(unwrapped);
  if (!parsed.success) {
    throw new Error(
      `Invalid Arex outbound-http response for trace ${traceId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const data = parsed.data;
  if (data.traceId !== undefined) {
    const lower = data.traceId.trim().toLowerCase();
    if (isTraceId(lower) && lower !== traceId) {
      throw new Error(
        `Arex outbound-http response traceId mismatch: expected ${traceId}, received ${lower}`,
      );
    }
  }

  if (data.state === "awaiting_server_span") {
    return { traceId, state: "awaiting_server_span" };
  }

  const serverSpanId = coerceOrDeterministicSpanId(data.serverEntry?.spanId, 1);
  const serverServiceName = data.serverEntry?.serviceName?.trim() || "arex-app";
  const serverMethod = data.serverEntry?.method?.trim().toUpperCase() || undefined;
  const serverRoute =
    data.serverEntry?.routeOrPath?.trim() ||
    data.serverEntry?.path?.trim() ||
    undefined;
  const serverStatus =
    typeof data.serverEntry?.status === "number"
      ? data.serverEntry.status
      : undefined;
  const serverDurationMs =
    typeof data.serverEntry?.durationMs === "number"
      ? data.serverEntry.durationMs
      : 0;

  const outboundHttp: OutboundHttpCall[] = (data.outboundHttp ?? []).map(
    (item, idx) => {
      const spanId = coerceOrDeterministicSpanId(
        item.spanId ?? item.recordId,
        idx + 2,
      );
      const candidateParent = item.parentServerSpanId?.trim().toLowerCase();
      const parentServerSpanId: SpanId =
        candidateParent !== undefined && isSpanId(candidateParent)
          ? candidateParent
          : serverSpanId;

      const request = buildCapturedHttpPayload({
        rawText: item.request?.text ?? item.request?.body ?? null,
        parsedJson: item.request?.json,
        headers: normalizeStringHeaders(item.request?.headers),
        explicitStatus: item.request?.captureStatus,
      });
      const response = buildCapturedHttpPayload({
        rawText: item.response?.text ?? item.response?.body ?? null,
        parsedJson: item.response?.json,
        headers: normalizeStringHeaders(item.response?.headers),
        explicitStatus: item.response?.captureStatus,
      });
      const resolvedExplorerUrl = item.explorerTraceUrl ?? explorerTraceUrl;

      return {
        traceId,
        spanId,
        parentServerSpanId,
        serviceName: item.serviceName?.trim() || serverServiceName,
        method: (item.method?.trim() || "GET").toUpperCase(),
        url: item.url,
        status: item.status ?? item.statusCode ?? 0,
        durationMs: item.durationMs ?? 0,
        request,
        response,
        ...(resolvedExplorerUrl ? { explorerTraceUrl: resolvedExplorerUrl } : {}),
      };
    },
  );

  return {
    traceId,
    state: "ingested",
    serverEntry: {
      spanId: serverSpanId,
      serviceName: serverServiceName,
      durationMs: serverDurationMs,
      ...(serverMethod ? { method: serverMethod } : {}),
      ...(serverRoute ? { routeOrPath: serverRoute } : {}),
      ...(serverStatus !== undefined ? { status: serverStatus } : {}),
    },
    outboundHttp,
  };
}

export interface ArexSinkOptions {
  readonly endpoint: string;
  readonly appId: string;
  readonly token?: string;
  readonly tenantId?: string;
  readonly explorerUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class ArexSink implements TraceSink {
  readonly kind = "arex" as const;
  readonly sinkUrl: string;
  readonly #appId: string;
  readonly #token: string | undefined;
  readonly #tenantId: string | undefined;
  readonly #explorerUrl: string | undefined;
  readonly #fetchImpl: typeof fetch;

  constructor(options: ArexSinkOptions) {
    this.sinkUrl = options.endpoint.replace(/\/+$/, "");
    this.#appId = options.appId.trim();
    this.#token = options.token;
    this.#tenantId = options.tenantId;
    this.#explorerUrl = options.explorerUrl;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  buildExplorerTraceUrl(traceId: TraceId): string | undefined {
    return formatExplorerTraceDeepLink(this.#explorerUrl, traceId);
  }

  async fetchTrace(
    traceId: TraceId,
    signal: AbortSignal,
  ): Promise<TracePollSnapshot> {
    const query = `appId=${encodeURIComponent(this.#appId)}`;
    const requestUrl = `${this.sinkUrl}/api/traces/${encodeURIComponent(traceId)}/outbound-http?${query}`;
    const response = await this.#fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...formatAuthHeader(this.#token),
        ...(this.#tenantId ? { "X-Tenant-Id": this.#tenantId } : {}),
      },
      signal,
    });

    if (response.status === 404) {
      return { traceId, state: "awaiting_server_span" };
    }

    if (!response.ok) {
      const retryable =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      const bodySnippet = (await response.text().catch(() => "")).slice(0, 240);
      throw new SinkHttpError(
        `Arex trace lookup GET ${requestUrl} failed with HTTP ${response.status}${bodySnippet ? ` (${bodySnippet})` : ""}`,
        response.status,
        retryable,
      );
    }

    const rawJson: unknown = await response.json();
    return parseArexTracePayload(
      traceId,
      rawJson,
      this.buildExplorerTraceUrl(traceId),
    );
  }
}
