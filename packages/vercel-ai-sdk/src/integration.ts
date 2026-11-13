import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  context as otelContext,
  propagation as otelPropagation,
  trace as otelTrace,
  TraceFlags,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  SoftprobeClient,
  getPropagatedAttributes,
  withAttributes,
  type SoftprobeClientOptions,
} from "@softprobe/tracing";

export type SoftprobePrompt = {
  name: string;
  version: number;
  isFallback?: boolean;
};

export type SoftprobeVercelAiSdkIntegrationOptions = {
  tracer?: Tracer;
  apiKey?: string;
  publicKey?: string;
  baseUrl?: string;
  serviceName?: string;
  environment?: string;
  spanExporter?: SoftprobeClientOptions["spanExporter"];
  useSimpleProcessor?: SoftprobeClientOptions["useSimpleProcessor"];
};

export type OpenTelemetrySpanType = string;

const PROMPT_SPAN_TYPES = new Set<string>([
  "languageModel",
  "embedding",
  "reranking",
  "doGenerate",
  "doStream",
  "generate",
]);

const SESSION_ID_KEYS = [
  "sessionId",
  "session_id",
  "threadId",
  "thread_id",
  "conversationId",
  "conversation_id",
  "chatId",
  "chat_id",
];

const USER_ID_KEYS = ["userId", "user_id"];

function observationTypeFor(spanType: string, operationId?: string): string {
  if (spanType.includes("tool")) return "tool";
  if (spanType.includes("embed") || operationId?.includes("embed")) {
    return "embedding";
  }
  if (
    spanType.includes("languageModel") ||
    spanType.toLowerCase().includes("generate") ||
    spanType.includes("doStream") ||
    spanType.includes("doGenerate")
  ) {
    return "generation";
  }
  if (spanType.includes("rerank") || operationId?.includes("rerank")) {
    return "retriever";
  }
  if (spanType === "operation") return "agent";
  return "span";
}

function readPropagatedIdentity(): { sessionId?: string; userId?: string } {
  try {
    return getPropagatedAttributes() ?? {};
  } catch {
    return {};
  }
}

const kSoftprobeHttpPatched = Symbol.for("softprobe.vercelAi.httpPatched");
const kSoftprobeFetchPatched = Symbol.for("softprobe.vercelAi.fetchPatched");
const kSoftprobeHttpClientPatched = Symbol.for(
  "softprobe.vercelAi.httpClientPatched",
);
const TRACEPARENT_RE =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:$|-[0-9a-f])/i;
const SESSION_HEADER_KEYS = [
  "x-softprobe-session-id",
  "x-session-id",
  "x-conversation-id",
  "x-thread-id",
  "x-chat-id",
];
const excludedCollectorPrefixes = new Set<string>([
  "https://explorer.softprobe.ai/api/thelake",
  "https://explorer-staging.softprobe.ai/api/thelake",
]);

function registerExcludedBaseUrl(candidate: string | undefined): void {
  const trimmed = candidate?.trim().replace(/\/+$/, "");
  if (trimmed) excludedCollectorPrefixes.add(trimmed);
}

function shouldSkipOutgoingTracePropagation(rawUrl: string): boolean {
  if (!rawUrl) return false;
  for (const prefix of excludedCollectorPrefixes) {
    if (
      rawUrl === prefix ||
      rawUrl.startsWith(`${prefix}/`) ||
      rawUrl.startsWith(`${prefix}?`)
    ) {
      return true;
    }
  }
  try {
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    if (/\/v1\/(?:traces|logs|metrics|scores)\/?$/i.test(parsed.pathname)) {
      return true;
    }
    if (/\/api\/thelake(?:\/|$)/i.test(parsed.pathname)) {
      return true;
    }
  } catch {}
  return false;
}

function activeOutgoingTraceHeaders():
  | { traceparent: string; tracestate?: string }
  | undefined {
  const spanCtx = otelTrace.getSpanContext(otelContext.active());
  if (!spanCtx || !otelTrace.isSpanContextValid(spanCtx)) return undefined;
  const flags =
    (spanCtx.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
      ? "01"
      : "00";
  const tracestate = spanCtx.traceState?.serialize();
  return {
    traceparent: `00-${spanCtx.traceId}-${spanCtx.spanId}-${flags}`,
    ...(tracestate ? { tracestate } : {}),
  };
}

function patchGlobalFetch(): void {
  const current = globalThis.fetch as
    | (typeof fetch & Record<symbol, boolean> & { __original?: typeof fetch })
    | undefined;
  if (typeof current !== "function" || current[kSoftprobeFetchPatched]) return;

  const wrapped = function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const traceHeaders = activeOutgoingTraceHeaders();
    if (!traceHeaders) {
      return Reflect.apply(current, this, [input, init]) as Promise<Response>;
    }
    let urlString = "";
    try {
      urlString =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : typeof Request !== "undefined" && input instanceof Request
              ? input.url
              : String(input);
    } catch {}
    if (shouldSkipOutgoingTracePropagation(urlString)) {
      return Reflect.apply(current, this, [input, init]) as Promise<Response>;
    }
    try {
      const baseHeaders =
        init?.headers ??
        (typeof Request !== "undefined" && input instanceof Request
          ? input.headers
          : undefined);
      const headers = new Headers(baseHeaders);
      if (headers.has("traceparent")) {
        return Reflect.apply(current, this, [input, init]) as Promise<Response>;
      }
      headers.set("traceparent", traceHeaders.traceparent);
      if (traceHeaders.tracestate && !headers.has("tracestate")) {
        headers.set("tracestate", traceHeaders.tracestate);
      }
      return Reflect.apply(current, this, [
        input,
        { ...(init ?? {}), headers },
      ]) as Promise<Response>;
    } catch {
      return Reflect.apply(current, this, [input, init]) as Promise<Response>;
    }
  };
  Object.defineProperty(wrapped, kSoftprobeFetchPatched, { value: true });
  if (current.__original) {
    Object.defineProperty(wrapped, "__original", { value: current.__original });
  }
  globalThis.fetch = wrapped as typeof fetch;
}

function hasHeaderIgnoreCase(
  headers: Record<string, unknown>,
  target: string,
): boolean {
  const lower = target.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function withInjectedNodeHeaders(
  existing: unknown,
  traceHeaders: { traceparent: string; tracestate?: string },
): unknown {
  if (Array.isArray(existing)) return existing;
  if (existing && typeof existing === "object") {
    const record = existing as Record<string, unknown>;
    if (hasHeaderIgnoreCase(record, "traceparent")) return existing;
    return {
      ...record,
      traceparent: traceHeaders.traceparent,
      ...(traceHeaders.tracestate && !hasHeaderIgnoreCase(record, "tracestate")
        ? { tracestate: traceHeaders.tracestate }
        : {}),
    };
  }
  return {
    traceparent: traceHeaders.traceparent,
    ...(traceHeaders.tracestate ? { tracestate: traceHeaders.tracestate } : {}),
  };
}

function resolveNodeRequestUrl(
  defaultProtocol: string,
  firstArg: unknown,
  secondArg: unknown,
): string {
  if (typeof firstArg === "string") return firstArg;
  if (firstArg instanceof URL) return firstArg.href;
  const opts = (
    firstArg && typeof firstArg === "object"
      ? firstArg
      : secondArg && typeof secondArg === "object"
        ? secondArg
        : undefined
  ) as
    | {
        protocol?: string;
        hostname?: string;
        host?: string;
        port?: string | number;
        path?: string;
      }
    | undefined;
  if (!opts) return "";
  const protocol = opts.protocol || defaultProtocol;
  const host =
    opts.host ||
    (opts.hostname
      ? `${opts.hostname}${opts.port ? `:${opts.port}` : ""}`
      : "127.0.0.1");
  const path = opts.path || "/";
  return `${protocol}//${host}${path.startsWith("/") ? path : `/${path}`}`;
}

function patchHttpClientModule(
  mod: { request: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown } &
    Record<symbol, boolean>,
  defaultProtocol: string,
): void {
  if (!mod || mod[kSoftprobeHttpClientPatched]) return;
  mod[kSoftprobeHttpClientPatched] = true;

  const wrapMethod = (
    original: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => unknown) =>
    function patchedClientMethod(this: unknown, ...args: unknown[]): unknown {
      const traceHeaders = activeOutgoingTraceHeaders();
      if (!traceHeaders) return Reflect.apply(original, this, args);
      const url = resolveNodeRequestUrl(defaultProtocol, args[0], args[1]);
      if (shouldSkipOutgoingTracePropagation(url)) {
        return Reflect.apply(original, this, args);
      }
      if (typeof args[0] === "string" || args[0] instanceof URL) {
        if (
          args[1] &&
          typeof args[1] === "object" &&
          !(args[1] instanceof URL)
        ) {
          const opts = args[1] as Record<string, unknown>;
          const nextOpts = {
            ...opts,
            headers: withInjectedNodeHeaders(opts.headers, traceHeaders),
          };
          return Reflect.apply(original, this, [
            args[0],
            nextOpts,
            ...args.slice(2),
          ]);
        }
        return Reflect.apply(original, this, [
          args[0],
          { headers: withInjectedNodeHeaders(undefined, traceHeaders) },
          ...args.slice(1),
        ]);
      }
      if (args[0] && typeof args[0] === "object") {
        const opts = args[0] as Record<string, unknown>;
        const nextOpts = {
          ...opts,
          headers: withInjectedNodeHeaders(opts.headers, traceHeaders),
        };
        return Reflect.apply(original, this, [nextOpts, ...args.slice(1)]);
      }
      return Reflect.apply(original, this, args);
    };

  if (typeof mod.request === "function") {
    mod.request = wrapMethod(mod.request);
  }
  if (typeof mod.get === "function") {
    mod.get = wrapMethod(mod.get);
  }
}

function headerString(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim()) {
    return raw[0].trim();
  }
  return undefined;
}

function extractIncomingTraceContext(
  headers: Record<string, unknown> | undefined,
): Context {
  let ctx = otelContext.active();
  if (!headers) return ctx;
  try {
    ctx = otelPropagation.extract(ctx, headers);
  } catch {}
  const existing = otelTrace.getSpanContext(ctx);
  if (existing?.traceId && existing.spanId) return ctx;

  const traceparent = headerString(headers, "traceparent");
  if (!traceparent) return ctx;
  const match = TRACEPARENT_RE.exec(traceparent);
  if (!match) return ctx;
  const traceId = match[1]!.toLowerCase();
  const spanId = match[2]!.toLowerCase();
  const flags = Number.parseInt(match[3]!, 16);
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return ctx;
  return otelTrace.setSpanContext(ctx, {
    traceId,
    spanId,
    traceFlags:
      (flags & 0x01) === 0x01 ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}

function extractIncomingSessionId(req: {
  url?: string;
  headers?: Record<string, unknown>;
}): string | undefined {
  for (const key of SESSION_HEADER_KEYS) {
    const value = headerString(req.headers, key);
    if (value && /^[!-~]{1,128}$/.test(value)) return value;
  }
  const rawUrl = typeof req.url === "string" ? req.url : "";
  if (rawUrl) {
    const pathMatch = rawUrl.match(/(?:^|\/)sessions?\/([!-~]{1,128}?)(?:\/|\?|$)/);
    if (pathMatch?.[1] && /^[!-~]{1,128}$/.test(pathMatch[1])) {
      return decodeURIComponent(pathMatch[1]);
    }
    try {
      const parsed = new URL(rawUrl, "http://127.0.0.1");
      for (const key of SESSION_ID_KEYS) {
        const param = parsed.searchParams.get(key)?.trim();
        if (param && /^[!-~]{1,128}$/.test(param)) return param;
      }
    } catch {}
  }
  return undefined;
}

function patchServerPrototype(proto: unknown): void {
  const target = proto as
    | ({ emit: (...args: unknown[]) => boolean } & Record<symbol, boolean>)
    | null
    | undefined;
  if (!target || typeof target.emit !== "function" || target[kSoftprobeHttpPatched]) {
    return;
  }
  target[kSoftprobeHttpPatched] = true;
  const originalEmit = target.emit;
  target.emit = function patchedEmit(
    this: unknown,
    event: unknown,
    ...args: unknown[]
  ): boolean {
    if (event === "request" && args[0] && typeof args[0] === "object") {
      const req = args[0] as {
        url?: string;
        headers?: Record<string, unknown>;
      };
      const nextContext = extractIncomingTraceContext(req.headers);
      const sessionId = extractIncomingSessionId(req);
      const invoke = (): boolean =>
        Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      return otelContext.with(nextContext, () =>
        sessionId ? (withAttributes({ sessionId }, invoke) as boolean) : invoke(),
      );
    }
    return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
  };
}

export function installIncomingHttpContextPropagation(options?: {
  excludedBaseUrl?: string;
}): void {
  registerExcludedBaseUrl(options?.excludedBaseUrl);
  registerExcludedBaseUrl(process.env.SOFTPROBE_BASE_URL);
  registerExcludedBaseUrl(process.env.SOFTPROBE_OTLP_ENDPOINT);
  try {
    patchServerPrototype(http.Server.prototype);
    patchServerPrototype(https.Server.prototype);
    patchGlobalFetch();
    patchHttpClientModule(
      http as unknown as {
        request: (...args: unknown[]) => unknown;
        get: (...args: unknown[]) => unknown;
      } & Record<symbol, boolean>,
      "http:",
    );
    patchHttpClientModule(
      https as unknown as {
        request: (...args: unknown[]) => unknown;
        get: (...args: unknown[]) => unknown;
      } & Record<symbol, boolean>,
      "https:",
    );
    syncBuiltinESMExports();
  } catch {}
}

function firstString(
  context: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!context) return undefined;
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

const DIRECT_SESSION_ATTRIBUTE_KEYS = [
  "session.id",
  "sp.session.id",
  "gen_ai.conversation.id",
  ...SESSION_ID_KEYS,
];

const DIRECT_USER_ATTRIBUTE_KEYS = [
  "user.id",
  "sp.user.id",
  ...USER_ID_KEYS,
];

const TELEMETRY_METADATA_PREFIX = "ai.telemetry.metadata.";
const TELEMETRY_SESSION_KEYS = SESSION_ID_KEYS.map(
  (key) => `${TELEMETRY_METADATA_PREFIX}${key}`,
);
const TELEMETRY_USER_KEYS = USER_ID_KEYS.map(
  (key) => `${TELEMETRY_METADATA_PREFIX}${key}`,
);

function readBaggageString(
  ctx: Context,
  keys: readonly string[],
): string | undefined {
  const contexts =
    ctx === otelContext.active() ? [ctx] : [ctx, otelContext.active()];
  for (const candidateCtx of contexts) {
    try {
      const baggage = otelPropagation.getBaggage(candidateCtx);
      if (!baggage) continue;
      for (const key of keys) {
        const value = baggage.getEntry(key)?.value?.trim();
        if (value) return value;
      }
    } catch {}
  }
  return undefined;
}

function extractRecordIdentity(source: Record<string, unknown> | undefined): {
  sessionId?: string;
  userId?: string;
} {
  const nestedMetadata = isPlainObject(source?.metadata)
    ? source.metadata
    : undefined;
  const sessionId =
    firstString(source, DIRECT_SESSION_ATTRIBUTE_KEYS) ??
    firstString(nestedMetadata, SESSION_ID_KEYS) ??
    firstString(source, TELEMETRY_SESSION_KEYS);
  const userId =
    firstString(source, DIRECT_USER_ATTRIBUTE_KEYS) ??
    firstString(nestedMetadata, USER_ID_KEYS) ??
    firstString(source, TELEMETRY_USER_KEYS);
  return { sessionId, userId };
}

// OTel GenAI Agent Spans semantic conventions define `gen_ai.conversation.id`
// as a multi-trace session/conversation identifier; omit session attributes
// when no explicit, metadata, propagated HTTP, or baggage session ID exists.
function resolveSpanIdentity(
  source: Record<string, unknown> | undefined,
  ctx: Context = otelContext.active(),
): { sessionId?: string; userId?: string } {
  const fromRecord = extractRecordIdentity(source);
  const propagated = readPropagatedIdentity();
  const sessionId =
    fromRecord.sessionId ??
    propagated.sessionId?.trim() ??
    readBaggageString(ctx, DIRECT_SESSION_ATTRIBUTE_KEYS);
  const userId =
    fromRecord.userId ??
    propagated.userId?.trim() ??
    readBaggageString(ctx, DIRECT_USER_ATTRIBUTE_KEYS);
  return {
    sessionId: sessionId || undefined,
    userId: userId || undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSerialize(value: unknown): string | undefined {
  try {
    if (value == null) return undefined;
    return JSON.stringify(value);
  } catch {
    return "<failed to serialize>";
  }
}

function normalizePrompt(value: unknown): SoftprobePrompt | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.name !== "string" || typeof value.version !== "number") {
    return undefined;
  }
  return {
    name: value.name,
    version: value.version,
    isFallback:
      typeof value.isFallback === "boolean" ? value.isFallback : false,
  };
}

/**
 * Enrich AI SDK / OTEL spans with Softprobe observation attributes.
 * Works standalone for AI SDK v6 `experimental_telemetry` metadata mapping,
 * and is used by SoftprobeVercelAiSdkIntegration for AI SDK 7.
 */
export function createSoftprobeObservationAttributes(params: {
  runtimeContext?: Record<string, unknown>;
  spanType: OpenTelemetrySpanType;
  operationId?: string;
}): Attributes {
  const { runtimeContext, spanType, operationId } = params;
  const observationType = observationTypeFor(String(spanType), operationId);
  const attributes: Attributes = {
    "sp.observation.type": observationType,
  };

  const { sessionId, userId } = resolveSpanIdentity(runtimeContext);
  if (sessionId) {
    attributes["session.id"] = sessionId;
    attributes["sp.session.id"] = sessionId;
    attributes["gen_ai.conversation.id"] = sessionId;
  }

  if (userId) {
    attributes["user.id"] = userId;
    attributes["sp.user.id"] = userId;
  }

  if (!runtimeContext) return attributes;

  const { softprobePrompt, langfusePrompt, ...metadata } = runtimeContext;
  const prompt = normalizePrompt(softprobePrompt ?? langfusePrompt);

  if (PROMPT_SPAN_TYPES.has(String(spanType)) && prompt && !prompt.isFallback) {
    attributes["sp.prompt.name"] = prompt.name;
    attributes["sp.prompt.version"] = prompt.version;
  }

  if (observationType === "tool") {
    const toolName = firstString(runtimeContext, [
      "toolName",
      "tool_name",
      "name",
    ]);
    const toolCallId = firstString(runtimeContext, [
      "toolCallId",
      "tool_call_id",
      "callId",
      "call_id",
    ]);
    if (toolName) attributes["gen_ai.tool.name"] = toolName;
    if (toolCallId) attributes["gen_ai.tool.call.id"] = toolCallId;
    attributes["sp.tool.kind"] = "function";
    const status = firstString(runtimeContext, ["toolStatus", "status"]);
    if (status) attributes["sp.tool.status"] = status;
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (
      [
        "toolName",
        "tool_name",
        "toolCallId",
        "tool_call_id",
        "callId",
        "call_id",
        "toolStatus",
        "status",
        "name",
      ].includes(key)
    ) {
      continue;
    }
    const serialized =
      typeof value === "string" ? value : safeSerialize(value);
    if (serialized != null) {
      attributes[`sp.metadata.${key}`] = serialized;
    }
  }

  return attributes;
}

type OtelSpanProcessor = NonNullable<
  SoftprobeClientOptions["spanProcessors"]
>[number];

type ReadableAiSpanLike = {
  readonly name?: string;
  readonly attributes?: Record<string, unknown>;
  readonly instrumentationLibrary?: { readonly name?: string };
  readonly instrumentationScope?: { readonly name?: string };
};

function isVercelAiSpan(span: ReadableAiSpanLike): boolean {
  const scopeName =
    span.instrumentationScope?.name ?? span.instrumentationLibrary?.name;
  if (scopeName === "ai") return true;
  const name = span.name ?? "";
  if (
    name.startsWith("ai.") ||
    name.startsWith("invoke_agent") ||
    name.startsWith("chat ") ||
    name.startsWith("execute_tool")
  ) {
    return true;
  }
  const attrs = span.attributes;
  if (!attrs) return false;
  if (attrs["sp.observation.type"] !== undefined) return true;
  return Object.keys(attrs).some(
    (key) => key.startsWith("ai.") || key.startsWith("gen_ai."),
  );
}

function inferVercelAiSpanType(
  spanName: string,
  attrs: Record<string, unknown>,
): string {
  const operationId =
    typeof attrs["ai.operationId"] === "string"
      ? attrs["ai.operationId"]
      : typeof attrs["operation.name"] === "string"
        ? attrs["operation.name"]
        : spanName;
  const genAiOp =
    typeof attrs["gen_ai.operation.name"] === "string"
      ? attrs["gen_ai.operation.name"]
      : "";
  if (
    operationId === "ai.toolCall" ||
    operationId.includes("tool") ||
    genAiOp === "execute_tool"
  ) {
    return "tool.call";
  }
  if (operationId.includes("doGenerate")) return "doGenerate";
  if (operationId.includes("doStream")) return "doStream";
  if (operationId.includes("embed") || genAiOp === "embeddings") {
    return "embedding";
  }
  if (operationId.includes("rerank")) return "reranking";
  if (
    genAiOp === "chat" ||
    genAiOp === "text_completion" ||
    genAiOp === "generate_content"
  ) {
    return "languageModel";
  }
  if (
    operationId.startsWith("ai.") ||
    genAiOp === "invoke_agent" ||
    genAiOp === "create_agent"
  ) {
    return "operation";
  }
  return "span";
}

export class SoftprobeVercelAiSpanProcessor implements OtelSpanProcessor {
  onStart(
    span: Span & ReadableAiSpanLike,
    parentContext: Context = otelContext.active(),
  ): void {
    if (!isVercelAiSpan(span)) return;
    const attrs = isPlainObject(span.attributes) ? span.attributes : {};
    const operationId =
      typeof attrs["ai.operationId"] === "string"
        ? attrs["ai.operationId"]
        : undefined;
    const inferredType = inferVercelAiSpanType(span.name ?? "", attrs);
    const observationType =
      typeof attrs["sp.observation.type"] === "string"
        ? attrs["sp.observation.type"]
        : observationTypeFor(inferredType, operationId);
    if (attrs["sp.observation.type"] === undefined) {
      span.setAttribute("sp.observation.type", observationType);
    }

    const { sessionId, userId } = resolveSpanIdentity(attrs, parentContext);
    if (sessionId) {
      span.setAttribute("session.id", sessionId);
      span.setAttribute("sp.session.id", sessionId);
      span.setAttribute("gen_ai.conversation.id", sessionId);
    }
    if (userId) {
      span.setAttribute("user.id", userId);
      span.setAttribute("sp.user.id", userId);
    }

    if (observationType === "tool") {
      const toolName = firstString(attrs, [
        "gen_ai.tool.name",
        "ai.toolCall.name",
      ]);
      const toolCallId = firstString(attrs, [
        "gen_ai.tool.call.id",
        "ai.toolCall.id",
      ]);
      if (toolName && attrs["gen_ai.tool.name"] === undefined) {
        span.setAttribute("gen_ai.tool.name", toolName);
      }
      if (toolCallId && attrs["gen_ai.tool.call.id"] === undefined) {
        span.setAttribute("gen_ai.tool.call.id", toolCallId);
      }
      if (attrs["sp.tool.kind"] === undefined) {
        span.setAttribute("sp.tool.kind", "function");
      }
    }

    for (const [key, value] of Object.entries(attrs)) {
      if (!key.startsWith(TELEMETRY_METADATA_PREFIX)) continue;
      const metaKey = key.slice(TELEMETRY_METADATA_PREFIX.length);
      if (
        !metaKey ||
        SESSION_ID_KEYS.includes(metaKey) ||
        USER_ID_KEYS.includes(metaKey) ||
        attrs[`sp.metadata.${metaKey}`] !== undefined
      ) {
        continue;
      }
      const serialized =
        typeof value === "string" ? value : safeSerialize(value);
      if (serialized != null) {
        span.setAttribute(`sp.metadata.${metaKey}`, serialized);
      }
    }
  }

  onEnd(span: ReadableAiSpanLike): void {
    if (!isVercelAiSpan(span) || !isPlainObject(span.attributes)) return;
    const attrs = span.attributes;
    if (attrs["gen_ai.conversation.id"] === undefined) {
      const { sessionId, userId } = extractRecordIdentity(attrs);
      if (sessionId) {
        attrs["session.id"] = sessionId;
        attrs["sp.session.id"] = sessionId;
        attrs["gen_ai.conversation.id"] = sessionId;
      }
      if (userId && attrs["user.id"] === undefined) {
        attrs["user.id"] = userId;
        attrs["sp.user.id"] = userId;
      }
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function resolveDefaultClient(
  options: SoftprobeVercelAiSdkIntegrationOptions,
): SoftprobeClient | undefined {
  if (options.tracer) return undefined;
  try {
    const serviceName = options.serviceName?.trim();
    return SoftprobeClient.fromEnv({
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.publicKey !== undefined
        ? { publicKey: options.publicKey }
        : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(serviceName ? { serviceName } : {}),
      ...(options.environment !== undefined
        ? { environment: options.environment }
        : {}),
      ...(options.spanExporter !== undefined
        ? { spanExporter: options.spanExporter }
        : {}),
      ...(options.useSimpleProcessor !== undefined
        ? { useSimpleProcessor: options.useSimpleProcessor }
        : {}),
      spanProcessors: [new SoftprobeVercelAiSpanProcessor()],
    });
  } catch {
    return undefined;
  }
}

type AiSdkOtelDelegate = {
  executeTool: (params: unknown) => PromiseLike<unknown>;
  executeLanguageModelCall: (params: unknown) => PromiseLike<unknown>;
  onStart: (...args: unknown[]) => void;
  onStepStart: (...args: unknown[]) => void;
  onLanguageModelCallStart: (...args: unknown[]) => void;
  onLanguageModelCallEnd: (...args: unknown[]) => void;
  onToolExecutionStart: (...args: unknown[]) => void;
  onToolExecutionEnd: (...args: unknown[]) => void;
  onStepEnd: (...args: unknown[]) => void;
  onObjectStepStart: (...args: unknown[]) => void;
  onObjectStepEnd: (...args: unknown[]) => void;
  onEmbedStart: (...args: unknown[]) => void;
  onEmbedEnd: (...args: unknown[]) => void;
  onRerankStart: (...args: unknown[]) => void;
  onRerankEnd: (...args: unknown[]) => void;
  onEnd: (...args: unknown[]) => void;
  onAbort: (...args: unknown[]) => void;
  onError: (...args: unknown[]) => void;
};

function hasExecute(
  params: unknown,
): params is { execute: () => PromiseLike<unknown> } {
  return isPlainObject(params) && typeof params.execute === "function";
}

function createPassThroughDelegate(): AiSdkOtelDelegate {
  const noop = (): void => undefined;
  return {
    executeTool: (params: unknown) =>
      hasExecute(params) ? params.execute() : Promise.resolve(undefined),
    executeLanguageModelCall: (params: unknown) =>
      hasExecute(params) ? params.execute() : Promise.resolve(undefined),
    onStart: noop,
    onStepStart: noop,
    onLanguageModelCallStart: noop,
    onLanguageModelCallEnd: noop,
    onToolExecutionStart: noop,
    onToolExecutionEnd: noop,
    onStepEnd: noop,
    onObjectStepStart: noop,
    onObjectStepEnd: noop,
    onEmbedStart: noop,
    onEmbedEnd: noop,
    onRerankStart: noop,
    onRerankEnd: noop,
    onEnd: noop,
    onAbort: noop,
    onError: noop,
  };
}

/**
 * AI SDK Telemetry integration.
 * Delegates lifecycle to `@ai-sdk/otel` when installed (AI SDK 7+) and attaches
 * `SoftprobeVercelAiSpanProcessor` to the OTel provider for standard AI SDK spans.
 */
export class SoftprobeVercelAiSdkIntegration {
  private readonly delegate: AiSdkOtelDelegate;
  private readonly client?: SoftprobeClient;
  readonly tracer?: Tracer;

  constructor(options: SoftprobeVercelAiSdkIntegrationOptions = {}) {
    installIncomingHttpContextPropagation({
      excludedBaseUrl: options.baseUrl,
    });
    this.client = resolveDefaultClient(options);
    const tracer = options.tracer ?? this.client?.tracer;
    this.tracer = tracer;

    const require = createRequire(import.meta.url);
    let OpenTelemetryCtor: (new (opts: unknown) => AiSdkOtelDelegate) | undefined;
    try {
      OpenTelemetryCtor = require("@ai-sdk/otel").OpenTelemetry;
    } catch {
      OpenTelemetryCtor = undefined;
    }

    this.delegate = OpenTelemetryCtor
      ? new OpenTelemetryCtor({
          tracer,
          enrichSpan: ({
            spanType,
            operationId,
            runtimeContext,
          }: {
            spanType: OpenTelemetrySpanType;
            operationId?: string;
            runtimeContext?: Record<string, unknown>;
          }) =>
            createSoftprobeObservationAttributes({
              spanType,
              operationId,
              runtimeContext,
            }),
        })
      : createPassThroughDelegate();
  }

  async forceFlush(): Promise<void> {
    await this.client?.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
  }

  executeTool<T>(params: {
    callId: string;
    toolCallId: string;
    execute: () => PromiseLike<T>;
  }): PromiseLike<T> {
    return this.delegate.executeTool(params) as PromiseLike<T>;
  }

  executeLanguageModelCall<T>(params: {
    callId: string;
    execute: () => PromiseLike<T>;
  }): PromiseLike<T> {
    return this.delegate.executeLanguageModelCall(params) as PromiseLike<T>;
  }

  onStart(...args: unknown[]): void {
    this.delegate.onStart(...args);
  }
  onStepStart(...args: unknown[]): void {
    this.delegate.onStepStart(...args);
  }
  onLanguageModelCallStart(...args: unknown[]): void {
    this.delegate.onLanguageModelCallStart(...args);
  }
  onLanguageModelCallEnd(...args: unknown[]): void {
    this.delegate.onLanguageModelCallEnd(...args);
  }
  onToolExecutionStart(...args: unknown[]): void {
    this.delegate.onToolExecutionStart(...args);
  }
  onToolExecutionEnd(...args: unknown[]): void {
    this.delegate.onToolExecutionEnd(...args);
  }
  onStepEnd(...args: unknown[]): void {
    this.delegate.onStepEnd(...args);
  }
  onObjectStepStart(...args: unknown[]): void {
    this.delegate.onObjectStepStart(...args);
  }
  onObjectStepEnd(...args: unknown[]): void {
    this.delegate.onObjectStepEnd(...args);
  }
  onEmbedStart(...args: unknown[]): void {
    this.delegate.onEmbedStart(...args);
  }
  onEmbedEnd(...args: unknown[]): void {
    this.delegate.onEmbedEnd(...args);
  }
  onRerankStart(...args: unknown[]): void {
    this.delegate.onRerankStart(...args);
  }
  onRerankEnd(...args: unknown[]): void {
    this.delegate.onRerankEnd(...args);
  }
  onEnd(...args: unknown[]): void {
    this.delegate.onEnd(...args);
  }
  onAbort(...args: unknown[]): void {
    this.delegate.onAbort(...args);
  }
  onError(...args: unknown[]): void {
    this.delegate.onError(...args);
  }
}

/**
 * Initialize Softprobe telemetry and register it with the Vercel AI SDK in one call.
 * Reads `SOFTPROBE_PUBLIC_KEY` (or `SOFTPROBE_API_KEY`) and defaults `SOFTPROBE_BASE_URL`
 * to `https://explorer.softprobe.ai/api/thelake`.
 */
export function initVercelAiTelemetry(
  options: SoftprobeVercelAiSdkIntegrationOptions = {},
): SoftprobeVercelAiSdkIntegration {
  const integration = new SoftprobeVercelAiSdkIntegration(options);
  try {
    const require = createRequire(import.meta.url);
    const ai = require("ai") as {
      registerTelemetry?: (integration: unknown) => void;
    };
    ai.registerTelemetry?.(integration);
  } catch {}
  return integration;
}
