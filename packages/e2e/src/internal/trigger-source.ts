import { z } from "zod";
import {
  isSpanId,
  isTraceId,
  type ClientTriggerFilter,
  type SpanId,
  type TraceId,
} from "../types.js";
import type { BrowserAttemptLedger, RecordedClientTrigger, TriggerLedgerView } from "./correlator.js";
import { formatAuthHeader, isJsonValue, SinkHttpError } from "./sink-shared.js";

export type { ClientTriggerFilter, RecordedClientTrigger };

export interface WindowBoundsMs {
  readonly startMs: number;
  readonly endMs: number;
}

export type LedgerTriggerSource = {
  readonly kind: "ledger";
  readonly readTriggers: () => readonly RecordedClientTrigger[];
  readonly captureWindow: (fn: () => Promise<void>) => Promise<TriggerSource>;
};

export type SessionTriggerSource = {
  readonly kind: "session";
  readonly sessionId: string;
  readonly windowBoundsMs?: WindowBoundsMs;
  readonly fetchSessionTriggers: (
    signal: AbortSignal,
  ) => Promise<readonly RecordedClientTrigger[]>;
  readonly captureWindow: (fn: () => Promise<void>) => Promise<TriggerSource>;
};

export type TriggerSource = LedgerTriggerSource | SessionTriggerSource;

export function createLedgerTriggerSource(
  ledger: BrowserAttemptLedger,
  view: TriggerLedgerView = ledger.rootView,
): LedgerTriggerSource {
  return {
    kind: "ledger",
    readTriggers: view,
    async captureWindow(fn: () => Promise<void>): Promise<TriggerSource> {
      const childView = await ledger.captureWindow(fn);
      return createLedgerTriggerSource(ledger, childView);
    },
  };
}

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

const sessionSpanSchema = z.object({
  traceId: z.unknown().optional(),
  trace_id: z.unknown().optional(),
  spanId: z.unknown().optional(),
  span_id: z.unknown().optional(),
  parentSpanId: z.unknown().optional(),
  parent_span_id: z.unknown().optional(),
  name: z.string().nullable().optional(),
  kind: z.unknown().optional(),
  span_kind: z.unknown().optional(),
  span_type: z.string().nullable().optional(),
  observation_type: z.string().nullable().optional(),
  startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  start_time_unix_nano: z.union([z.string(), z.number()]).optional(),
  start_time: z.string().nullable().optional(),
  attributes: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
});

const scopeSpansSchema = z.object({
  spans: z.array(sessionSpanSchema).optional(),
});

const resourceSpansSchema = z.object({
  scopeSpans: z.array(scopeSpansSchema).optional(),
  instrumentationLibrarySpans: z.array(scopeSpansSchema).optional(),
});

const sessionEnvelopeSchema = z.object({
  spans: z.array(sessionSpanSchema).optional(),
  observations: z.array(sessionSpanSchema).optional(),
  resourceSpans: z.array(resourceSpansSchema).optional(),
  batches: z.array(resourceSpansSchema).optional(),
  trace: z
    .object({
      resourceSpans: z.array(resourceSpansSchema).optional(),
    })
    .optional(),
});

type TriggerSpanKind = "CLIENT" | "SERVER" | "NON_HTTP" | "UNSPECIFIED";

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

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

function stringifyAnyValue(raw: unknown): string {
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
    return JSON.stringify(value.arrayValue.values.map(stringifyAnyValue));
  }
  if (Array.isArray(value.kvlistValue?.values)) {
    const out: Record<string, string> = {};
    for (const entry of value.kvlistValue.values) {
      const kv = otlpKeyValueSchema.safeParse(entry);
      if (kv.success) {
        out[kv.data.key] = stringifyAnyValue(kv.data.value);
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
      out[kv.data.key] = stringifyAnyValue(kv.data.value);
    }
    return out;
  }
  if (raw !== null && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue;
      out[key] = stringifyAnyValue(value);
    }
    return out;
  }
  return {};
}

function classifyTriggerSpanKind(
  rawKind: unknown,
  spanType: string | null | undefined,
  attrs: Readonly<Record<string, string>>,
): TriggerSpanKind {
  if (rawKind === 2 || rawKind === "SPAN_KIND_SERVER" || rawKind === "SERVER") {
    return "SERVER";
  }
  if (rawKind === 3 || rawKind === "SPAN_KIND_CLIENT" || rawKind === "CLIENT") {
    return "CLIENT";
  }
  if (
    rawKind === 1 ||
    rawKind === "SPAN_KIND_INTERNAL" ||
    rawKind === "INTERNAL" ||
    rawKind === 4 ||
    rawKind === "SPAN_KIND_PRODUCER" ||
    rawKind === "PRODUCER" ||
    rawKind === 5 ||
    rawKind === "SPAN_KIND_CONSUMER" ||
    rawKind === "CONSUMER"
  ) {
    return "NON_HTTP";
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
  if (
    attrKind === "INTERNAL" ||
    attrKind === "SPAN_KIND_INTERNAL" ||
    attrKind === "PRODUCER" ||
    attrKind === "SPAN_KIND_PRODUCER" ||
    attrKind === "CONSUMER" ||
    attrKind === "SPAN_KIND_CONSUMER"
  ) {
    return "NON_HTTP";
  }
  if (spanType === "http.server") return "SERVER";
  if (spanType === "http.client") return "CLIENT";
  return "UNSPECIFIED";
}

function parseStartNanoseconds(
  nanoRaw: string | number | undefined,
  isoRaw: string | null | undefined,
): bigint {
  if (typeof nanoRaw === "number") {
    if (Number.isFinite(nanoRaw) && nanoRaw > 0) {
      return BigInt(Math.trunc(nanoRaw));
    }
    return 0n;
  }
  if (typeof nanoRaw === "string") {
    const trimmed = nanoRaw.trim();
    if (/^\d+$/.test(trimmed)) {
      try {
        return BigInt(trimmed);
      } catch {
        return 0n;
      }
    }
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        return BigInt(Math.trunc(parsed));
      }
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

function inferLeadingVerb(spanName: string): string | undefined {
  const firstToken = spanName.trim().split(/\s+/)[0]?.toUpperCase();
  return firstToken !== undefined && HTTP_VERBS.has(firstToken) ? firstToken : undefined;
}

function cleanRouteCandidate(rawRoute: string | undefined): string | undefined {
  if (!rawRoute) return undefined;
  const trimmed = rawRoute.trim();
  if (!trimmed) return undefined;
  const strippedMethod = trimmed.replace(/^[A-Z]+\s+/, "").trim();
  return strippedMethod || undefined;
}

function normalizePathname(rawPathOrUrl: string): string {
  const withoutHash = (rawPathOrUrl.split("#")[0] ?? "/").trim();
  const withoutQuery = (withoutHash.split("?")[0] ?? "/").trim();
  if (!withoutQuery || withoutQuery === "/") return "/";
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function resolveHttpUrlAndPath(attrs: Readonly<Record<string, string>>): {
  readonly url: string;
  readonly origin: string;
  readonly pathname: string;
} | null {
  const direct = attrs["url.full"]?.trim() || attrs["http.url"]?.trim();
  if (direct) {
    try {
      const parsed = new URL(direct);
      return {
        url: direct,
        origin: parsed.origin,
        pathname: parsed.pathname || "/",
      };
    } catch {
      return {
        url: direct,
        origin: "",
        pathname: normalizePathname(direct),
      };
    }
  }

  const rawPath =
    attrs["url.path"]?.trim() ||
    attrs["http.target"]?.trim() ||
    cleanRouteCandidate(attrs["http.route"]);
  if (!rawPath) return null;

  if (/^https?:\/\//i.test(rawPath)) {
    try {
      const parsed = new URL(rawPath);
      return {
        url: rawPath,
        origin: parsed.origin,
        pathname: parsed.pathname || "/",
      };
    } catch {}
  }

  const host =
    attrs["server.address"]?.trim() ||
    attrs["net.peer.name"]?.trim() ||
    attrs["http.host"]?.trim();
  const pathname = normalizePathname(rawPath);
  const queryFromAttr = attrs["url.query"]?.trim();
  const inlineQuery = rawPath.includes("?") ? rawPath.slice(rawPath.indexOf("?") + 1) : "";
  const query = queryFromAttr || inlineQuery;

  if (host) {
    const scheme = attrs["url.scheme"]?.trim() || attrs["http.scheme"]?.trim() || "http";
    const port = attrs["server.port"]?.trim() || attrs["net.peer.port"]?.trim();
    const defaultPort =
      (scheme === "https" && port === "443") ||
      (scheme === "http" && port === "80") ||
      host.includes(":");
    const authority = port && !defaultPort ? `${host}:${port}` : host;
    const fullUrl = query
      ? `${scheme}://${authority}${pathname}?${query}`
      : `${scheme}://${authority}${pathname}`;
    return {
      url: fullUrl,
      origin: `${scheme}://${authority}`,
      pathname,
    };
  }

  const relativeUrl = query ? `${pathname}?${query}` : pathname;
  return {
    url: relativeUrl,
    origin: "",
    pathname,
  };
}

interface CandidateSessionSpan {
  readonly order: number;
  readonly traceId: TraceId;
  readonly spanId: SpanId | null;
  readonly parentSpanId: SpanId | null;
  readonly kind: "CLIENT" | "SERVER";
  readonly method: string;
  readonly url: string;
  readonly origin: string;
  readonly pathname: string;
  readonly startNs: bigint;
  readonly startedAt: number;
}

interface RawSpanLineageNode {
  readonly parentSpanId: SpanId | null;
  readonly isServer: boolean;
}

function hasAncestorServerSpan(
  span: CandidateSessionSpan,
  byIdInTrace: ReadonlyMap<SpanId, RawSpanLineageNode>,
): boolean {
  const visited = new Set<SpanId>();
  if (span.spanId !== null) visited.add(span.spanId);
  let cursor = span.parentSpanId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const parent = byIdInTrace.get(cursor);
    if (!parent) break;
    if (parent.isServer) return true;
    cursor = parent.parentSpanId;
  }
  return false;
}

export function extractSessionTriggersFromPayload(
  raw: unknown,
  windowBoundsMs?: WindowBoundsMs,
  clockSkewPadMs = 0,
): readonly RecordedClientTrigger[] {
  const rawSpans: Array<z.infer<typeof sessionSpanSchema>> = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const parsed = sessionSpanSchema.safeParse(entry);
      if (parsed.success) rawSpans.push(parsed.data);
    }
  } else {
    const envelope = sessionEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return [];
    const resourceBatches =
      envelope.data.trace?.resourceSpans ??
      envelope.data.batches ??
      envelope.data.resourceSpans ??
      [];
    for (const rs of resourceBatches) {
      for (const group of [
        ...(rs.scopeSpans ?? []),
        ...(rs.instrumentationLibrarySpans ?? []),
      ]) {
        for (const sp of group.spans ?? []) {
          rawSpans.push(sp);
        }
      }
    }
    for (const sp of [
      ...(envelope.data.spans ?? []),
      ...(envelope.data.observations ?? []),
    ]) {
      rawSpans.push(sp);
    }
  }

  const lineageByTrace = new Map<TraceId, Map<SpanId, RawSpanLineageNode>>();
  const candidates: CandidateSessionSpan[] = [];
  let order = 0;

  for (const item of rawSpans) {
    order += 1;
    const traceHex = decodeIdHex(item.traceId ?? item.trace_id, 16);
    if (!isTraceId(traceHex)) continue;

    const spanHex = decodeIdHex(item.spanId ?? item.span_id, 8);
    const spanId = isSpanId(spanHex) ? spanHex : null;
    const parentHex = decodeIdHex(item.parentSpanId ?? item.parent_span_id, 8);
    const parentSpanId = isSpanId(parentHex) ? parentHex : null;

    const attrs = parseAttributeMap(item.attributes);
    const spanName = item.name ?? "";
    const obsType =
      attrs["sp.observation.type"] ??
      attrs["observation_type"] ??
      item.observation_type ??
      "";
    const isInternalObservation =
      spanName === "softprobe.ui.action" ||
      spanName === "softprobe.web.recording" ||
      spanName === "softprobe.http.body.capture" ||
      obsType === "ui_action" ||
      obsType === "recording" ||
      obsType === "http_body";

    const classifiedKind = classifyTriggerSpanKind(
      item.kind ?? item.span_kind,
      item.span_type,
      attrs,
    );
    const isServerLineage =
      !isInternalObservation &&
      (classifiedKind === "SERVER" ||
        (classifiedKind === "UNSPECIFIED" && Boolean(attrs["http.route"])));

    if (spanId !== null) {
      let traceMap = lineageByTrace.get(traceHex);
      if (!traceMap) {
        traceMap = new Map<SpanId, RawSpanLineageNode>();
        lineageByTrace.set(traceHex, traceMap);
      }
      if (!traceMap.has(spanId)) {
        traceMap.set(spanId, {
          parentSpanId,
          isServer: isServerLineage,
        });
      }
    }

    if (isInternalObservation || classifiedKind === "NON_HTTP") {
      continue;
    }

    const method =
      attrs["http.request.method"]?.trim().toUpperCase() ||
      attrs["http.method"]?.trim().toUpperCase() ||
      inferLeadingVerb(spanName);
    if (!method) continue;

    const resolvedUrl = resolveHttpUrlAndPath(attrs);
    if (!resolvedUrl) continue;

    const effectiveKind: "CLIENT" | "SERVER" =
      classifiedKind === "UNSPECIFIED"
        ? attrs["http.route"]
          ? "SERVER"
          : "CLIENT"
        : classifiedKind;

    const startNs = parseStartNanoseconds(
      item.startTimeUnixNano ?? item.start_time_unix_nano,
      item.start_time,
    );
    const startedAt = startNs > 0n ? Number(startNs / 1_000_000n) : 0;

    candidates.push({
      order,
      traceId: traceHex,
      spanId,
      parentSpanId,
      kind: effectiveKind,
      method,
      url: resolvedUrl.url,
      origin: resolvedUrl.origin,
      pathname: resolvedUrl.pathname,
      startNs,
      startedAt,
    });
  }

  // Cloud thelake-collector stamps sp.session.id from W3C baggage onto backend spans, so exclude downstream CLIENT and nested SERVER spans under an entry SERVER span.
  const entryCandidates = candidates.filter((cand) => {
    const traceMap = lineageByTrace.get(cand.traceId);
    if (!traceMap) return true;
    return !hasAncestorServerSpan(cand, traceMap);
  });

  const traceIdsWithRootClient = new Set<TraceId>();
  for (const cand of entryCandidates) {
    if (cand.kind === "CLIENT") {
      traceIdsWithRootClient.add(cand.traceId);
    }
  }

  const pad = Math.max(0, clockSkewPadMs);
  const filtered = entryCandidates.filter((cand) => {
    if (cand.kind === "SERVER" && traceIdsWithRootClient.has(cand.traceId)) {
      return false;
    }
    if (windowBoundsMs !== undefined) {
      const minMs = windowBoundsMs.startMs - pad;
      const maxMs = windowBoundsMs.endMs + pad;
      if (cand.startedAt < minMs || cand.startedAt > maxMs) {
        return false;
      }
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (a.startNs !== b.startNs) return a.startNs < b.startNs ? -1 : 1;
    return a.order - b.order;
  });

  return filtered.map(
    (cand): RecordedClientTrigger => ({
      traceId: cand.traceId,
      ...(cand.spanId !== null ? { spanId: cand.spanId } : {}),
      headerSource: "preserved",
      method: cand.method,
      url: cand.url,
      origin: cand.origin,
      pathname: cand.pathname,
      startedAt: cand.startedAt,
    }),
  );
}

export interface BlackboxSessionTriggerSourceOptions {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly token?: string;
  readonly workspaceId?: string;
  readonly windowBoundsMs?: WindowBoundsMs;
  readonly clockSkewPadMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export function createBlackboxSessionTriggerSource(
  options: BlackboxSessionTriggerSourceOptions,
): SessionTriggerSource {
  const cleanEndpoint = options.endpoint.trim().replace(/\/+$/, "");
  const sessionId = options.sessionId.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const clockSkewPadMs = options.clockSkewPadMs ?? 0;
  let preferredSessionPrefix: string | null = null;

  const defaultPrefixes = cleanEndpoint.endsWith("/api/thelake")
    ? [cleanEndpoint]
    : [cleanEndpoint, `${cleanEndpoint}/api/thelake`];

  const fetchRawSession = async (signal: AbortSignal): Promise<unknown> => {
    const encodedSessionId = encodeURIComponent(sessionId);
    const prefixes = preferredSessionPrefix
      ? [
          preferredSessionPrefix,
          ...defaultPrefixes.filter((p) => p !== preferredSessionPrefix),
        ]
      : defaultPrefixes;

    let lastResponse: Response | null = null;
    let lastRequestUrl = `${prefixes[0]}/v1/llm/sessions/${encodedSessionId}`;

    for (const prefix of prefixes) {
      const requestUrl = `${prefix}/v1/llm/sessions/${encodedSessionId}`;
      lastRequestUrl = requestUrl;
      const response = await fetchImpl(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...formatAuthHeader(options.token),
          ...(options.workspaceId ? { "X-Workspace-Id": options.workspaceId } : {}),
        },
        signal,
      });
      lastResponse = response;
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (response.status === 404 || contentType.includes("text/html")) {
        continue;
      }
      if (!response.ok) {
        const retryable =
          response.status === 429 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504;
        const bodySnippet = (await response.text().catch(() => "")).slice(0, 240);
        throw new SinkHttpError(
          `Blackbox session lookup GET ${requestUrl} failed with HTTP ${response.status}${bodySnippet ? ` (${bodySnippet})` : ""}`,
          response.status,
          retryable,
        );
      }

      preferredSessionPrefix = prefix;
      return response.json();
    }

    if (lastResponse && !lastResponse.ok && lastResponse.status !== 404) {
      const retryable =
        lastResponse.status === 429 ||
        lastResponse.status === 502 ||
        lastResponse.status === 503 ||
        lastResponse.status === 504;
      const bodySnippet = (await lastResponse.text().catch(() => "")).slice(0, 240);
      throw new SinkHttpError(
        `Blackbox session lookup GET ${lastRequestUrl} failed with HTTP ${lastResponse.status}${bodySnippet ? ` (${bodySnippet})` : ""}`,
        lastResponse.status,
        retryable,
      );
    }

    return null;
  };

  const buildScopedSource = (bounds: WindowBoundsMs | undefined): SessionTriggerSource => ({
    kind: "session",
    sessionId,
    ...(bounds !== undefined ? { windowBoundsMs: bounds } : {}),
    async fetchSessionTriggers(signal: AbortSignal): Promise<readonly RecordedClientTrigger[]> {
      const rawPayload = await fetchRawSession(signal);
      if (rawPayload === null) return [];
      return extractSessionTriggersFromPayload(rawPayload, bounds, clockSkewPadMs);
    },
    async captureWindow(fn: () => Promise<void>): Promise<TriggerSource> {
      const startMs = now();
      await fn();
      const endMs = Math.max(startMs, now());
      const nextBounds: WindowBoundsMs =
        bounds !== undefined
          ? {
              startMs: Math.max(bounds.startMs, startMs),
              endMs: Math.min(bounds.endMs, endMs),
            }
          : { startMs, endMs };
      return buildScopedSource(nextBounds);
    },
  });

  return buildScopedSource(options.windowBoundsMs);
}
