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
  isJsonValue,
  SinkHttpError,
  stripSpJsonPrefix,
  type TracePollSnapshot,
  type TraceSink,
} from "./sink-shared.js";

const otlpKeyValueSchema = z.object({
  key: z.string(),
  value: z.unknown().optional(),
});

const otlpAnyValueSchema = z.object({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
  arrayValue: z.object({ values: z.array(z.unknown()).optional() }).optional(),
  kvlistValue: z.object({ values: z.array(z.unknown()).optional() }).optional(),
});

const otlpEventSchema = z.object({
  name: z.string().optional(),
  timeUnixNano: z.union([z.string(), z.number()]).optional(),
  attributes: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
});

const otlpSpanSchema = z.object({
  traceId: z.unknown().optional(),
  trace_id: z.unknown().optional(),
  spanId: z.unknown().optional(),
  span_id: z.unknown().optional(),
  parentSpanId: z.unknown().optional(),
  parent_span_id: z.unknown().optional(),
  name: z.string().optional(),
  kind: z.unknown().optional(),
  span_kind: z.unknown().optional(),
  span_type: z.string().optional(),
  service_name: z.string().optional(),
  startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  endTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  start_time: z.string().optional(),
  end_time: z.string().nullable().optional(),
  attributes: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  resource_attributes: z
    .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
    .optional(),
  events: z.array(otlpEventSchema).optional(),
});

const scopeSpansSchema = z.object({
  scope: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  spans: z.array(otlpSpanSchema).optional(),
});

const resourceSpansSchema = z.object({
  resource: z
    .object({
      attributes: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
    })
    .optional(),
  scopeSpans: z.array(scopeSpansSchema).optional(),
  instrumentationLibrarySpans: z.array(scopeSpansSchema).optional(),
});

const blackboxTraceEnvelopeSchema = z.object({
  trace: z
    .object({
      resourceSpans: z.array(resourceSpansSchema).optional(),
    })
    .optional(),
  batches: z.array(resourceSpansSchema).optional(),
  resourceSpans: z.array(resourceSpansSchema).optional(),
  spans: z.array(otlpSpanSchema).optional(),
});

type SpanKindNormalized =
  | "UNSPECIFIED"
  | "INTERNAL"
  | "SERVER"
  | "CLIENT"
  | "PRODUCER"
  | "CONSUMER";

interface ParsedBlackboxSpan {
  readonly spanId: SpanId;
  parentSpanId: SpanId | null;
  readonly name: string;
  readonly kind: SpanKindNormalized;
  readonly serviceName: string;
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly durationMs: number;
  attributes: Record<string, string>;
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly attributes: Record<string, string>;
  }>;
}

function decodeIdHex(raw: unknown, byteLength: 16 | 8): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const expectedHexLen = byteLength * 2;
  if (trimmed.length === expectedHexLen && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length !== byteLength) return "";
    return bytes.toString("hex").toLowerCase();
  } catch {
    return "";
  }
}

function parseSpanIdField(raw: unknown): SpanId | null {
  const hex = decodeIdHex(raw, 8);
  return isSpanId(hex) ? hex : null;
}

function stringifyOtlpAnyValue(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  const parsed = otlpAnyValueSchema.safeParse(raw);
  if (!parsed.success) {
    return isJsonValue(raw) ? JSON.stringify(raw) : "";
  }
  const value = parsed.data;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.intValue === "string" || typeof value.intValue === "number") {
    return String(value.intValue);
  }
  if (typeof value.doubleValue === "number") return String(value.doubleValue);
  if (typeof value.boolValue === "boolean") return String(value.boolValue);
  if (Array.isArray(value.arrayValue?.values)) {
    return JSON.stringify(value.arrayValue.values.map(stringifyOtlpAnyValue));
  }
  if (Array.isArray(value.kvlistValue?.values)) {
    const out: Record<string, string> = {};
    for (const entry of value.kvlistValue.values) {
      const kv = otlpKeyValueSchema.safeParse(entry);
      if (kv.success) {
        out[kv.data.key] = stringifyOtlpAnyValue(kv.data.value);
      }
    }
    return JSON.stringify(out);
  }
  return "";
}

function parseAttributeMap(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const item of raw) {
      const kv = otlpKeyValueSchema.safeParse(item);
      if (!kv.success) continue;
      out[kv.data.key] = stringifyOtlpAnyValue(kv.data.value);
    }
    return out;
  }
  if (raw !== null && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue;
      out[key] = stringifyOtlpAnyValue(value);
    }
    return out;
  }
  return {};
}

function normalizeSpanKind(
  rawKind: unknown,
  spanType: string | undefined,
  attrs: Readonly<Record<string, string>>,
): SpanKindNormalized {
  if (rawKind === 2 || rawKind === "SPAN_KIND_SERVER" || rawKind === "SERVER") {
    return "SERVER";
  }
  if (rawKind === 3 || rawKind === "SPAN_KIND_CLIENT" || rawKind === "CLIENT") {
    return "CLIENT";
  }
  if (rawKind === 1 || rawKind === "SPAN_KIND_INTERNAL" || rawKind === "INTERNAL") {
    return "INTERNAL";
  }
  if (rawKind === 4 || rawKind === "SPAN_KIND_PRODUCER" || rawKind === "PRODUCER") {
    return "PRODUCER";
  }
  if (rawKind === 5 || rawKind === "SPAN_KIND_CONSUMER" || rawKind === "CONSUMER") {
    return "CONSUMER";
  }
  const attrKind = (
    attrs["sp.span.kind"] ??
    attrs["span.kind"] ??
    attrs["otel.span.kind"] ??
    ""
  )
    .trim()
    .toUpperCase();
  if (attrKind === "SERVER" || attrKind === "SPAN_KIND_SERVER") return "SERVER";
  if (attrKind === "CLIENT" || attrKind === "SPAN_KIND_CLIENT") return "CLIENT";
  if (attrKind === "INTERNAL" || attrKind === "SPAN_KIND_INTERNAL") return "INTERNAL";
  if (spanType === "http.server") return "SERVER";
  if (spanType === "http.client") return "CLIENT";
  return "UNSPECIFIED";
}

function parseNanoseconds(
  nanoRaw: string | number | undefined,
  isoRaw: string | null | undefined,
): bigint {
  if (nanoRaw !== undefined) {
    try {
      return BigInt(nanoRaw);
    } catch {
      return 0n;
    }
  }
  if (typeof isoRaw === "string" && isoRaw.trim() !== "") {
    const ms = Date.parse(isoRaw);
    if (Number.isFinite(ms) && ms > 0) {
      return BigInt(Math.trunc(ms)) * 1_000_000n;
    }
  }
  return 0n;
}

function isBodyCaptureSpan(span: ParsedBlackboxSpan): boolean {
  return (
    span.name === "softprobe.http.body.capture" ||
    span.attributes["sp.observation.type"] === "http_body" ||
    span.attributes["observation_type"] === "http_body"
  );
}

const SKIP_BODY_MERGE_KEYS = new Set(["sp.observation.type", "observation_type"]);
const BODY_PRIORITY_PREFIXES = [
  "http.request.body",
  "http.response.body",
  "http.request.header",
  "http.response.header",
  "sp.http.",
  "sp.body.",
  "request.body",
  "response.body",
];

function mergeBodyAttributesIntoTarget(
  targetAttrs: Record<string, string>,
  sourceAttrs: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...targetAttrs };
  for (const [key, value] of Object.entries(sourceAttrs)) {
    if (SKIP_BODY_MERGE_KEYS.has(key)) continue;
    const isPriority = BODY_PRIORITY_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (isPriority || !merged[key]) {
      merged[key] = value;
    }
  }
  return merged;
}

function extractHeaderAttributes(
  attrs: Readonly<Record<string, string>>,
  direction: "request" | "response",
): Record<string, string> {
  const headers: Record<string, string> = {};
  const mapKey = `http.${direction}.headers`;
  const rawMap = attrs[mapKey];
  if (rawMap !== undefined) {
    const stripped = stripSpJsonPrefix(rawMap).trim();
    try {
      const parsed: unknown = JSON.parse(stripped);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, val] of Object.entries(parsed)) {
          if (typeof val === "string") {
            headers[name.toLowerCase()] = val;
          } else if (Array.isArray(val)) {
            headers[name.toLowerCase()] = val.map(String).join(", ");
          }
        }
      }
    } catch {}
  }

  const prefix = `http.${direction}.header.`;
  for (const [key, rawValue] of Object.entries(attrs)) {
    if (!key.startsWith(prefix)) continue;
    const headerName = key.slice(prefix.length).toLowerCase().replace(/_/g, "-");
    if (!headerName) continue;
    const stripped = stripSpJsonPrefix(rawValue).trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(stripped);
        if (Array.isArray(parsed)) {
          headers[headerName] = parsed.map(String).join(", ");
          continue;
        }
      } catch {}
    }
    headers[headerName] = stripped;
  }

  return headers;
}

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function inferLeadingVerb(spanName: string): string | undefined {
  const firstToken = spanName.trim().split(/\s+/)[0]?.toUpperCase();
  return firstToken !== undefined && HTTP_VERBS.has(firstToken) ? firstToken : undefined;
}

function reconstructClientUrl(attrs: Readonly<Record<string, string>>): string | undefined {
  const direct = attrs["url.full"]?.trim() || attrs["http.url"]?.trim();
  if (direct) return direct;

  const host = attrs["server.address"]?.trim() || attrs["net.peer.name"]?.trim();
  if (!host) return undefined;

  const scheme = attrs["url.scheme"]?.trim() || attrs["http.scheme"]?.trim() || "https";
  const port = attrs["server.port"]?.trim() || attrs["net.peer.port"]?.trim();
  const defaultPort = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  const authority = port && !defaultPort ? `${host}:${port}` : host;
  const rawPath = attrs["url.path"]?.trim() || attrs["http.target"]?.trim() || "/";
  const pathPart = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const query = attrs["url.query"]?.trim();
  return query ? `${scheme}://${authority}${pathPart}?${query}` : `${scheme}://${authority}${pathPart}`;
}

function parseHttpStatus(attrs: Readonly<Record<string, string>>): number | undefined {
  const raw =
    attrs["http.response.status_code"]?.trim() ??
    attrs["http.status_code"]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function extractBodyText(
  attrs: Readonly<Record<string, string>>,
  direction: "request" | "response",
): string | null {
  const candidates =
    direction === "request"
      ? [
          attrs["http.request.body.content"],
          attrs["http.request.body"],
          attrs["sp.http.request.body"],
          attrs["request.body"],
        ]
      : [
          attrs["http.response.body.content"],
          attrs["http.response.body"],
          attrs["sp.http.response.body"],
          attrs["response.body"],
        ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

function findAncestorServerSpan(
  span: ParsedBlackboxSpan,
  byId: ReadonlyMap<SpanId, ParsedBlackboxSpan>,
): ParsedBlackboxSpan | undefined {
  const visited = new Set<SpanId>([span.spanId]);
  let cursorId = span.parentSpanId;
  let nearestServer: ParsedBlackboxSpan | undefined;
  while (cursorId !== null && !visited.has(cursorId)) {
    visited.add(cursorId);
    const parent = byId.get(cursorId);
    if (!parent) break;
    if (parent.kind === "SERVER") {
      nearestServer = parent;
    }
    cursorId = parent.parentSpanId;
  }
  return nearestServer;
}

export function parseBlackboxTracePayload(
  traceId: TraceId,
  raw: unknown,
  explorerTraceUrl: string | undefined,
): TracePollSnapshot {
  const envelope = blackboxTraceEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { traceId, state: "awaiting_server_span" };
  }

  const parsedSpans: ParsedBlackboxSpan[] = [];
  const pushRawSpan = (
    item: z.infer<typeof otlpSpanSchema>,
    resourceAttrs: Readonly<Record<string, string>>,
  ) => {
    const rawTraceHex = decodeIdHex(item.traceId ?? item.trace_id, 16);
    if (rawTraceHex !== "" && isTraceId(rawTraceHex) && rawTraceHex !== traceId) {
      return;
    }
    const spanId = parseSpanIdField(item.spanId ?? item.span_id);
    if (spanId === null) return;
    const parentSpanId = parseSpanIdField(item.parentSpanId ?? item.parent_span_id);
    const spanAttrs = parseAttributeMap(item.attributes);
    const inlineResAttrs = parseAttributeMap(item.resource_attributes);
    const combinedResAttrs = { ...resourceAttrs, ...inlineResAttrs };
    const serviceName =
      item.service_name?.trim() ||
      combinedResAttrs["service.name"]?.trim() ||
      spanAttrs["service.name"]?.trim() ||
      spanAttrs["sp.app.id"]?.trim() ||
      "unknown-service";
    const startNs = parseNanoseconds(item.startTimeUnixNano, item.start_time);
    const endNsRaw = parseNanoseconds(item.endTimeUnixNano, item.end_time);
    const endNs = endNsRaw >= startNs ? endNsRaw : startNs;
    const durationMs = Number((endNs - startNs) / 1000n) / 1000;

    const events = (item.events ?? []).map((ev) => ({
      name: ev.name ?? "event",
      attributes: parseAttributeMap(ev.attributes),
    }));

    let mergedAttrs = spanAttrs;
    for (const ev of events) {
      if (
        ev.name === "softprobe.http.body.capture" ||
        ev.attributes["sp.observation.type"] === "http_body"
      ) {
        mergedAttrs = mergeBodyAttributesIntoTarget(mergedAttrs, ev.attributes);
      }
    }

    parsedSpans.push({
      spanId,
      parentSpanId,
      name: item.name ?? "span",
      kind: normalizeSpanKind(item.kind ?? item.span_kind, item.span_type, mergedAttrs),
      serviceName,
      startNs,
      endNs,
      durationMs,
      attributes: mergedAttrs,
      events,
    });
  };

  const resourceBatches =
    envelope.data.trace?.resourceSpans ??
    envelope.data.batches ??
    envelope.data.resourceSpans ??
    [];

  for (const rs of resourceBatches) {
    const resourceAttrs = parseAttributeMap(rs.resource?.attributes);
    const scopeGroups = [
      ...(rs.scopeSpans ?? []),
      ...(rs.instrumentationLibrarySpans ?? []),
    ];
    for (const group of scopeGroups) {
      for (const item of group.spans ?? []) {
        pushRawSpan(item, resourceAttrs);
      }
    }
  }

  for (const item of envelope.data.spans ?? []) {
    pushRawSpan(item, {});
  }

  if (parsedSpans.length === 0) {
    return { traceId, state: "awaiting_server_span" };
  }

  const byId = new Map<SpanId, ParsedBlackboxSpan>();
  for (const span of parsedSpans) {
    if (!byId.has(span.spanId)) {
      byId.set(span.spanId, span);
    }
  }

  const foldedHelperIds = new Set<SpanId>();
  for (const span of byId.values()) {
    if (!isBodyCaptureSpan(span)) continue;
    let folded = false;

    if (span.parentSpanId !== null) {
      const parent = byId.get(span.parentSpanId);
      if (parent && !isBodyCaptureSpan(parent) && parent.kind === "CLIENT") {
        parent.attributes = mergeBodyAttributesIntoTarget(
          parent.attributes,
          span.attributes,
        );
        folded = true;
      }
    }

    for (const child of byId.values()) {
      if (child.parentSpanId === span.spanId && !isBodyCaptureSpan(child)) {
        child.attributes = mergeBodyAttributesIntoTarget(
          child.attributes,
          span.attributes,
        );
        child.parentSpanId = span.parentSpanId;
        folded = true;
      }
    }

    if (!folded && span.parentSpanId !== null) {
      const helperUrl = reconstructClientUrl(span.attributes);
      const siblingClients = [...byId.values()].filter(
        (candidate) =>
          candidate.spanId !== span.spanId &&
          candidate.kind === "CLIENT" &&
          candidate.parentSpanId === span.parentSpanId &&
          (helperUrl === undefined ||
            reconstructClientUrl(candidate.attributes) === helperUrl),
      );
      if (siblingClients.length === 1 && siblingClients[0] !== undefined) {
        siblingClients[0].attributes = mergeBodyAttributesIntoTarget(
          siblingClients[0].attributes,
          span.attributes,
        );
        folded = true;
      } else {
        const parent = byId.get(span.parentSpanId);
        if (parent && !isBodyCaptureSpan(parent)) {
          parent.attributes = mergeBodyAttributesIntoTarget(
            parent.attributes,
            span.attributes,
          );
          folded = true;
        }
      }
    }

    if (folded) {
      foldedHelperIds.add(span.spanId);
    }
  }

  const activeSpans = [...byId.values()]
    .filter((span) => !foldedHelperIds.has(span.spanId))
    .sort((a, b) => {
      if (a.startNs !== b.startNs) return a.startNs < b.startNs ? -1 : 1;
      return a.spanId.localeCompare(b.spanId);
    });

  const activeById = new Map<SpanId, ParsedBlackboxSpan>(
    activeSpans.map((span) => [span.spanId, span]),
  );

  const serverSpans = activeSpans.filter((span) => span.kind === "SERVER");
  if (serverSpans.length === 0) {
    return { traceId, state: "awaiting_server_span" };
  }

  const rootServer =
    serverSpans.find((span) => findAncestorServerSpan(span, activeById) === undefined) ??
    serverSpans[0]!;

  const serverMethod =
    rootServer.attributes["http.request.method"]?.trim().toUpperCase() ||
    rootServer.attributes["http.method"]?.trim().toUpperCase() ||
    inferLeadingVerb(rootServer.name);
  const serverRoute =
    rootServer.attributes["http.route"]?.trim() ||
    rootServer.attributes["url.path"]?.trim() ||
    rootServer.attributes["http.target"]?.trim();
  const serverStatus = parseHttpStatus(rootServer.attributes);

  const outboundHttp: OutboundHttpCall[] = [];
  for (const span of activeSpans) {
    if (span.kind !== "CLIENT") continue;
    const ancestorServer = findAncestorServerSpan(span, activeById);
    if (!ancestorServer) continue;

    const url = reconstructClientUrl(span.attributes);
    const methodAttr =
      span.attributes["http.request.method"]?.trim().toUpperCase() ||
      span.attributes["http.method"]?.trim().toUpperCase() ||
      inferLeadingVerb(span.name);
    if (!url || !methodAttr) continue;

    const status = parseHttpStatus(span.attributes) ?? 0;
    const explicitCaptureStatus = span.attributes["sp.body.capture.status"]?.trim();

    const request = buildCapturedHttpPayload({
      rawText: extractBodyText(span.attributes, "request"),
      headers: extractHeaderAttributes(span.attributes, "request"),
      explicitStatus: explicitCaptureStatus,
    });
    const response = buildCapturedHttpPayload({
      rawText: extractBodyText(span.attributes, "response"),
      headers: extractHeaderAttributes(span.attributes, "response"),
      explicitStatus: explicitCaptureStatus,
    });

    outboundHttp.push({
      traceId,
      spanId: span.spanId,
      parentServerSpanId: ancestorServer.spanId,
      serviceName:
        span.serviceName !== "unknown-service"
          ? span.serviceName
          : ancestorServer.serviceName,
      method: methodAttr,
      url,
      status,
      durationMs: span.durationMs,
      request,
      response,
      ...(explorerTraceUrl ? { explorerTraceUrl } : {}),
    });
  }

  return {
    traceId,
    state: "ingested",
    serverEntry: {
      spanId: rootServer.spanId,
      serviceName: rootServer.serviceName,
      durationMs: rootServer.durationMs,
      ...(serverMethod ? { method: serverMethod } : {}),
      ...(serverRoute ? { routeOrPath: serverRoute } : {}),
      ...(serverStatus !== undefined ? { status: serverStatus } : {}),
    },
    outboundHttp,
  };
}

export interface BlackboxSinkOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly workspaceId?: string;
  readonly explorerUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class BlackboxSink implements TraceSink {
  readonly kind = "blackbox" as const;
  readonly sinkUrl: string;
  readonly #token: string | undefined;
  readonly #workspaceId: string | undefined;
  readonly #explorerUrl: string | undefined;
  readonly #fetchImpl: typeof fetch;

  constructor(options: BlackboxSinkOptions) {
    this.sinkUrl = options.endpoint.replace(/\/+$/, "");
    this.#token = options.token;
    this.#workspaceId = options.workspaceId;
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
    const requestUrl = `${this.sinkUrl}/api/traces/${encodeURIComponent(traceId)}`;
    const response = await this.#fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...formatAuthHeader(this.#token),
        ...(this.#workspaceId ? { "X-Workspace-Id": this.#workspaceId } : {}),
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
        `Blackbox trace lookup GET ${requestUrl} failed with HTTP ${response.status}${bodySnippet ? ` (${bodySnippet})` : ""}`,
        response.status,
        retryable,
      );
    }

    const rawJson: unknown = await response.json();
    return parseBlackboxTracePayload(
      traceId,
      rawJson,
      this.buildExplorerTraceUrl(traceId),
    );
  }
}
