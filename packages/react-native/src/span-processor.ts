import {
  context,
  propagation,
  SpanKind,
  type Context,
  type HrTime,
  type Span,
} from "@opentelemetry/api";
import {
  ExportResultCode,
  suppressTracing,
  type ExportResult,
} from "@opentelemetry/core";
import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  BAGGAGE_SESSION_KEY,
  parseMobileSessionId,
  type FetchOtlpJsonSpanExporterOptions,
  type LaunchArgumentsInput,
  type MobilePlatform,
  type MobileSessionId,
  type SoftprobeMobileSpanProcessorOptions,
} from "./types.js";

const LAUNCH_ARG_SESSION_KEYS = [
  "sp_session_id",
  "spSessionId",
  "-spSessionId",
  "--sp-session-id",
  "-sp_session_id",
  "--sp_session_id",
] as const;

const LAUNCH_ARG_KEY_SET = new Set<string>(
  LAUNCH_ARG_SESSION_KEYS.map((k) => k.toLowerCase()),
);

const EXPLICIT_SPAN_SESSION_KEYS = [
  "sp.session.id",
  "session.id",
  "gen_ai.conversation.id",
] as const;

function randomHexBytes(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteCount; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

export function generateDefaultMobileSessionId(): MobileSessionId {
  const candidate = `sp-rn-${Date.now().toString(36)}-${randomHexBytes(6)}`;
  const parsed = parseMobileSessionId(candidate);
  if (!parsed) {
    throw new Error("Generated mobile session ID failed ASCII validation");
  }
  return parsed;
}

function readSessionIdFromArgArray(args: readonly string[]): MobileSessionId | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const rawToken = args[i];
    if (typeof rawToken !== "string") continue;
    const token = rawToken.trim();
    if (!token) continue;

    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const keyPart = token.slice(0, eqIdx).trim().toLowerCase();
      const valPart = token.slice(eqIdx + 1);
      if (LAUNCH_ARG_KEY_SET.has(keyPart)) {
        const valid = parseMobileSessionId(valPart);
        if (valid) return valid;
      }
      continue;
    }

    if (LAUNCH_ARG_KEY_SET.has(token.toLowerCase())) {
      const nextVal = args[i + 1];
      const valid = parseMobileSessionId(nextVal);
      if (valid) return valid;
    }
  }
  return undefined;
}

function readSessionIdFromRecord(
  record: Readonly<Record<string, unknown>>,
): MobileSessionId | undefined {
  for (const preferredKey of LAUNCH_ARG_SESSION_KEYS) {
    if (preferredKey in record) {
      const valid = parseMobileSessionId(record[preferredKey]);
      if (valid) return valid;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (LAUNCH_ARG_KEY_SET.has(key.trim().toLowerCase())) {
      const valid = parseMobileSessionId(value);
      if (valid) return valid;
    }
  }
  return undefined;
}

function isReadonlyStringArray(
  value: LaunchArgumentsInput,
): value is readonly string[] {
  return Array.isArray(value);
}

export function extractLaunchArgumentSessionId(
  launchArguments: LaunchArgumentsInput | undefined,
): MobileSessionId | undefined {
  if (!launchArguments) return undefined;
  if (isReadonlyStringArray(launchArguments)) {
    return readSessionIdFromArgArray(launchArguments);
  }
  return readSessionIdFromRecord(launchArguments);
}

export function resolveMobileSessionId(options?: {
  readonly sessionId?: string;
  readonly launchArguments?: LaunchArgumentsInput;
  readonly generateSessionId?: () => string;
}): MobileSessionId {
  const explicit = parseMobileSessionId(options?.sessionId);
  if (explicit) return explicit;

  const fromLaunch = extractLaunchArgumentSessionId(options?.launchArguments);
  if (fromLaunch) return fromLaunch;

  if (options?.generateSessionId) {
    const custom = parseMobileSessionId(options.generateSessionId());
    if (custom) return custom;
  }

  return generateDefaultMobileSessionId();
}

function readExistingSpanSessionId(
  attrs: Readonly<Record<string, unknown>> | undefined,
): MobileSessionId | undefined {
  if (!attrs) return undefined;
  for (const key of EXPLICIT_SPAN_SESSION_KEYS) {
    const parsed = parseMobileSessionId(attrs[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

function readContextBaggageSessionId(ctx: Context): MobileSessionId | undefined {
  const raw = propagation.getBaggage(ctx)?.getEntry(BAGGAGE_SESSION_KEY)?.value;
  return parseMobileSessionId(raw);
}

export class SoftprobeMobileSpanProcessor implements SpanProcessor {
  readonly platform: MobilePlatform;
  readonly serviceName: string | undefined;
  readonly #resourceAttributes: Readonly<Record<string, string | number | boolean>>;
  #sessionId: MobileSessionId;

  constructor(options: SoftprobeMobileSpanProcessorOptions) {
    this.platform = options.platform;
    this.serviceName = options.serviceName?.trim() || undefined;
    this.#resourceAttributes = { ...(options.resourceAttributes ?? {}) };
    this.#sessionId = resolveMobileSessionId({
      sessionId: options.sessionId,
      launchArguments: options.launchArguments,
      generateSessionId: options.generateSessionId,
    });
  }

  getSessionId(): MobileSessionId {
    return this.#sessionId;
  }

  setSessionId(nextSessionId: string): MobileSessionId {
    const parsed = parseMobileSessionId(nextSessionId);
    if (!parsed) {
      throw new Error(
        `Invalid Softprobe sessionId: expected 1..128 printable ASCII characters`,
      );
    }
    this.#sessionId = parsed;
    return this.#sessionId;
  }

  onStart(
    span: Span & { readonly attributes?: Readonly<Record<string, unknown>> },
    parentContext: Context,
  ): void {
    const effectiveSessionId =
      readExistingSpanSessionId(span.attributes) ??
      readContextBaggageSessionId(parentContext) ??
      this.#sessionId;

    span.setAttribute("sp.session.id", effectiveSessionId);
    span.setAttribute("session.id", effectiveSessionId);
    span.setAttribute("sp.platform", this.platform);

    if (this.serviceName && !span.attributes?.["service.name"]) {
      span.setAttribute("service.name", this.serviceName);
    }

    for (const [key, value] of Object.entries(this.#resourceAttributes)) {
      if (span.attributes?.[key] === undefined) {
        span.setAttribute(key, value);
      }
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface OtlpJsonAnyValue {
  readonly stringValue?: string;
  readonly intValue?: string;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
  readonly arrayValue?: { readonly values: readonly OtlpJsonAnyValue[] };
}

export interface OtlpJsonKeyValue {
  readonly key: string;
  readonly value: OtlpJsonAnyValue;
}

export interface OtlpJsonExportPayload {
  readonly resourceSpans: ReadonlyArray<{
    readonly resource: { readonly attributes: readonly OtlpJsonKeyValue[] };
    readonly scopeSpans: ReadonlyArray<{
      readonly scope: { readonly name: string; readonly version?: string };
      readonly spans: ReadonlyArray<{
        readonly traceId: string;
        readonly spanId: string;
        readonly parentSpanId?: string;
        readonly name: string;
        readonly kind: number;
        readonly startTimeUnixNano: string;
        readonly endTimeUnixNano: string;
        readonly attributes: readonly OtlpJsonKeyValue[];
        readonly events: ReadonlyArray<{
          readonly name: string;
          readonly timeUnixNano: string;
          readonly attributes: readonly OtlpJsonKeyValue[];
        }>;
        readonly status: { readonly code: number; readonly message?: string };
      }>;
    }>;
  }>;
}

function hrTimeToUnixNanoString(hr: HrTime): string {
  const seconds = BigInt(Math.trunc(hr[0]));
  const nanos = BigInt(Math.trunc(hr[1]));
  return (seconds * 1_000_000_000n + nanos).toString();
}

// @opentelemetry/api numbers SpanKind 0..4 (INTERNAL..CONSUMER), whereas OTLP wire SpanKind reserves 0 for UNSPECIFIED and shifts INTERNAL..CONSUMER to 1..5.
function toOtlpWireSpanKind(kind: SpanKind): number {
  switch (kind) {
    case SpanKind.INTERNAL:
      return 1;
    case SpanKind.SERVER:
      return 2;
    case SpanKind.CLIENT:
      return 3;
    case SpanKind.PRODUCER:
      return 4;
    case SpanKind.CONSUMER:
      return 5;
    default:
      return 0;
  }
}

function encodeOtlpAnyValue(value: unknown): OtlpJsonAnyValue | undefined {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    const encodedItems: OtlpJsonAnyValue[] = [];
    for (const item of value) {
      const encoded = encodeOtlpAnyValue(item);
      if (encoded !== undefined) {
        encodedItems.push(encoded);
      }
    }
    return { arrayValue: { values: encodedItems } };
  }
  return undefined;
}

function encodeAttributeList(
  attrs: Readonly<Record<string, unknown>> | undefined,
): OtlpJsonKeyValue[] {
  if (!attrs) return [];
  const out: OtlpJsonKeyValue[] = [];
  for (const [key, rawVal] of Object.entries(attrs)) {
    if (rawVal === undefined || rawVal === null) continue;
    const encoded = encodeOtlpAnyValue(rawVal);
    if (encoded !== undefined) {
      out.push({ key, value: encoded });
    }
  }
  return out;
}

export function serializeReadableSpansToOtlpJson(
  spans: readonly ReadableSpan[],
  extraResourceAttributes?: Readonly<Record<string, string | number | boolean>>,
): OtlpJsonExportPayload {
  if (spans.length === 0) {
    return { resourceSpans: [] };
  }

  const firstResourceAttrs: Record<string, unknown> = {
    ...(spans[0]?.resource?.attributes ?? {}),
    ...(extraResourceAttributes ?? {}),
  };

  const byScope = new Map<
    string,
    {
      readonly name: string;
      readonly version?: string;
      readonly spans: Array<
        OtlpJsonExportPayload["resourceSpans"][number]["scopeSpans"][number]["spans"][number]
      >;
    }
  >();

  for (const span of spans) {
    const scopeName = span.instrumentationLibrary?.name ?? "@softprobe/react-native";
    const scopeVersion = span.instrumentationLibrary?.version;
    const scopeKey = `${scopeName}@${scopeVersion ?? ""}`;

    let group = byScope.get(scopeKey);
    if (!group) {
      group = {
        name: scopeName,
        ...(scopeVersion ? { version: scopeVersion } : {}),
        spans: [],
      };
      byScope.set(scopeKey, group);
    }

    const ctx = span.spanContext();
    if (!firstResourceAttrs["service.name"] && typeof span.attributes["service.name"] === "string") {
      firstResourceAttrs["service.name"] = span.attributes["service.name"];
    }

    group.spans.push({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      name: span.name,
      kind: toOtlpWireSpanKind(span.kind),
      startTimeUnixNano: hrTimeToUnixNanoString(span.startTime),
      endTimeUnixNano: hrTimeToUnixNanoString(span.endTime),
      attributes: encodeAttributeList(span.attributes),
      events: span.events.map((ev) => ({
        name: ev.name,
        timeUnixNano: hrTimeToUnixNanoString(ev.time),
        attributes: encodeAttributeList(ev.attributes),
      })),
      status: {
        code: span.status.code,
        ...(span.status.message ? { message: span.status.message } : {}),
      },
    });
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: encodeAttributeList(firstResourceAttrs),
        },
        scopeSpans: [...byScope.values()].map((g) => ({
          scope: {
            name: g.name,
            ...(g.version ? { version: g.version } : {}),
          },
          spans: g.spans,
        })),
      },
    ],
  };
}

export function resolveOtlpTracesUrl(options: {
  readonly tracesEndpoint?: string;
  readonly endpoint?: string;
}): string {
  const direct = options.tracesEndpoint?.trim();
  if (direct) return direct;
  const base = options.endpoint?.trim();
  if (!base) {
    throw new Error(
      "FetchOtlpJsonSpanExporter requires either `tracesEndpoint` or `endpoint`",
    );
  }
  const clean = base.replace(/\/+$/, "");
  return clean.endsWith("/v1/traces") ? clean : `${clean}/v1/traces`;
}

function resolveUnwrappedGlobalFetch(): typeof fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global `fetch` is unavailable for FetchOtlpJsonSpanExporter");
  }
  const candidate: typeof fetch = globalThis.fetch;
  if (
    "__softprobeOriginalFetch" in candidate &&
    typeof candidate.__softprobeOriginalFetch === "function"
  ) {
    return candidate.__softprobeOriginalFetch.bind(globalThis);
  }
  return candidate.bind(globalThis);
}

export class FetchOtlpJsonSpanExporter implements SpanExporter {
  readonly tracesUrl: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMillis: number;
  readonly #fetchImpl: (() => typeof fetch);
  readonly #extraResourceAttrs: Readonly<Record<string, string | number | boolean>>;
  readonly #inflight = new Set<Promise<void>>();
  #shutdown = false;

  constructor(options: FetchOtlpJsonSpanExporterOptions) {
    this.tracesUrl = resolveOtlpTracesUrl(options);
    this.#timeoutMillis = options.timeoutMillis ?? 15_000;
    const explicitFetch = options.fetchImpl;
    this.#fetchImpl = explicitFetch
      ? () => explicitFetch
      : () => resolveUnwrappedGlobalFetch();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    };
    const hasAuth = Object.keys(headers).some(
      (k) => k.toLowerCase() === "authorization",
    );
    if (!hasAuth && options.ingestionKey?.trim()) {
      headers.Authorization = `Bearer ${options.ingestionKey.trim()}`;
    }
    this.#headers = headers;

    this.#extraResourceAttrs = {
      ...(options.serviceName?.trim()
        ? { "service.name": options.serviceName.trim() }
        : {}),
      ...(options.resourceAttributes ?? {}),
    };
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.#shutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("FetchOtlpJsonSpanExporter has been shut down"),
      });
      return;
    }
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    let body: string;
    try {
      body = JSON.stringify(
        serializeReadableSpansToOtlpJson(spans, this.#extraResourceAttrs),
      );
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const task = context
      .with(suppressTracing(context.active()), () => this.#postJson(body))
      .then((result) => {
        resultCallback(result);
      })
      .finally(() => {
        this.#inflight.delete(task);
      });
    this.#inflight.add(task);
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.forceFlush();
  }

  async #postJson(body: string): Promise<ExportResult> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.#timeoutMillis);
    try {
      const fetchFn = this.#fetchImpl();
      const response = await fetchFn(this.tracesUrl, {
        method: "POST",
        headers: this.#headers,
        body,
        signal: abortController.signal,
      });
      await response.text().catch(() => "");
      if (response.status >= 200 && response.status <= 299) {
        return { code: ExportResultCode.SUCCESS };
      }
      return {
        code: ExportResultCode.FAILED,
        error: new Error(`OTLP JSON export failed with HTTP ${response.status}`),
      };
    } catch (error) {
      return {
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
