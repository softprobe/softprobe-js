import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  createContextKey,
  propagation,
  ROOT_CONTEXT,
  trace,
  type BaggageEntry,
  type Context,
  type ContextManager,
  type Span,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { JsonValue } from "./types.js";

export const BAGGAGE_SESSION_KEY = "sp.session.id";

const EXPLICIT_SESSION_ATTR_KEYS = [
  "sp.session.id",
  "session.id",
  "gen_ai.conversation.id",
] as const;

const SESSION_ID_ASCII_RE = /^[!-~]{1,128}$/;

export function normalizeValidSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SESSION_ID_ASCII_RE.test(trimmed) ? trimmed : undefined;
}

export interface PropagatedAttributes {
  sessionId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, JsonValue>;
  version?: string;
  release?: string;
  traceName?: string;
}

const storage = new AsyncLocalStorage<PropagatedAttributes>();
const fallbackContextStorage = new AsyncLocalStorage<Context>();
const contextProbeKey = createContextKey("softprobe.context.probe");

class FallbackAsyncLocalStorageContextManager implements ContextManager {
  active(): Context {
    return fallbackContextStorage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return fallbackContextStorage.run(ctx, () =>
      Reflect.apply(fn, thisArg, args),
    );
  }

  bind<T>(ctx: Context, target: T): T {
    if (typeof target !== "function") return target;
    const bound = (...args: unknown[]) =>
      this.with(ctx, target as (...inner: unknown[]) => unknown, undefined, ...args);
    return bound as unknown as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    fallbackContextStorage.disable();
    return this;
  }
}

export function ensureActiveContextManager(): void {
  const probeCtx = ROOT_CONTEXT.setValue(contextProbeKey, true);
  const working = context.with(
    probeCtx,
    () => context.active().getValue(contextProbeKey) === true,
  );
  if (!working) {
    context.setGlobalContextManager(
      new FallbackAsyncLocalStorageContextManager().enable(),
    );
  }
}

export function createSoftprobePropagator(): TextMapPropagator {
  return new CompositePropagator({
    propagators: [
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
    ],
  });
}

const w3cPropagator = createSoftprobePropagator();

const recordHeaderGetter: TextMapGetter<Record<string, unknown>> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    const direct = carrier[key];
    if (typeof direct === "string") return direct;
    if (Array.isArray(direct)) {
      return direct.filter((item): item is string => typeof item === "string");
    }
    const lower = key.toLowerCase();
    for (const [entryKey, value] of Object.entries(carrier)) {
      if (entryKey.toLowerCase() !== lower) continue;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string");
      }
    }
    return undefined;
  },
};

const recordHeaderSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

export function setSessionBaggage(
  baseContext: Context,
  sessionId: string | undefined,
): Context {
  const valid = normalizeValidSessionId(sessionId);
  if (!valid) return baseContext;
  const existing = propagation.getBaggage(baseContext);
  const entries: Record<string, BaggageEntry> = {};
  if (existing) {
    for (const [key, entry] of existing.getAllEntries()) {
      entries[key] = entry;
    }
  }
  entries[BAGGAGE_SESSION_KEY] = { value: valid };
  return propagation.setBaggage(
    baseContext,
    propagation.createBaggage(entries),
  );
}

export function getBaggageSessionId(
  ctx: Context = context.active(),
): string | undefined {
  const candidates =
    ctx === context.active() ? [ctx] : [ctx, context.active()];
  for (const candidate of candidates) {
    const raw = propagation
      .getBaggage(candidate)
      ?.getEntry(BAGGAGE_SESSION_KEY)?.value;
    const valid = normalizeValidSessionId(raw);
    if (valid) return valid;
  }
  return undefined;
}

export function extractTraceContext(
  headers: Record<string, unknown> | undefined,
  baseContext: Context = context.active(),
): Context {
  if (!headers) return baseContext;
  return w3cPropagator.extract(baseContext, headers, recordHeaderGetter);
}

export function withExtractedHeaders<T>(
  headers: Record<string, unknown> | undefined,
  fn: () => T,
): T {
  ensureActiveContextManager();
  const nextContext = extractTraceContext(headers, context.active());
  return context.with(nextContext, fn);
}

function extractBaggageMemberKey(member: string): string | undefined {
  const eqIdx = member.indexOf("=");
  if (eqIdx <= 0) return undefined;
  const key = member.slice(0, eqIdx).trim();
  return key.length > 0 ? key : undefined;
}

export function mergeBaggageHeaderValues(
  existing: string | undefined,
  injected: string | undefined,
): string | undefined {
  const existingTrimmed = existing?.trim() ?? "";
  const injectedTrimmed = injected?.trim() ?? "";
  if (!existingTrimmed) return injectedTrimmed || undefined;
  if (!injectedTrimmed) return existingTrimmed;

  const members: string[] = [];
  const seenKeys = new Set<string>();
  for (const raw of existingTrimmed.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    members.push(item);
    const key = extractBaggageMemberKey(item);
    if (key) seenKeys.add(key);
  }
  for (const raw of injectedTrimmed.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const key = extractBaggageMemberKey(item);
    if (key && seenKeys.has(key)) continue;
    if (key) seenKeys.add(key);
    members.push(item);
  }
  return members.length > 0 ? members.join(",") : undefined;
}

function takeCaseInsensitiveHeader(
  headers: Record<string, string>,
  target: string,
): string | undefined {
  const lower = target.toLowerCase();
  const values: string[] = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const val = headers[key];
      if (typeof val === "string" && val.trim().length > 0) {
        values.push(val.trim());
      }
      delete headers[key];
    }
  }
  return values.length > 0 ? values.join(",") : undefined;
}

export function injectTraceHeaders(
  initialHeaders?: Record<string, string>,
  ctx: Context = context.active(),
): Record<string, string> {
  const out: Record<string, string> = { ...(initialHeaders ?? {}) };
  const priorBaggage = takeCaseInsensitiveHeader(out, "baggage");
  let effectiveCtx = ctx;
  if (!getBaggageSessionId(effectiveCtx)) {
    const activeSpanAttrs = (
      trace.getSpan(effectiveCtx) as
        | (Span & { readonly attributes?: Record<string, unknown> })
        | undefined
    )?.attributes;
    const fallbackSession =
      normalizeValidSessionId(storage.getStore()?.sessionId) ??
      readExplicitSessionAttribute(activeSpanAttrs);
    if (fallbackSession) {
      effectiveCtx = setSessionBaggage(effectiveCtx, fallbackSession);
    }
  }
  const injected: Record<string, string> = {};
  w3cPropagator.inject(effectiveCtx, injected, recordHeaderSetter);
  if (injected.traceparent) {
    takeCaseInsensitiveHeader(out, "traceparent");
    out.traceparent = injected.traceparent;
  }
  if (injected.tracestate) {
    takeCaseInsensitiveHeader(out, "tracestate");
    out.tracestate = injected.tracestate;
  }
  const mergedBaggage = mergeBaggageHeaderValues(priorBaggage, injected.baggage);
  if (mergedBaggage) {
    out.baggage = mergedBaggage;
  }
  return out;
}

export function getPropagatedAttributes(): PropagatedAttributes {
  return { ...(storage.getStore() ?? {}) };
}

export function withAttributes<T>(
  attributes: PropagatedAttributes,
  fn: () => T,
): T {
  ensureActiveContextManager();
  const current = getPropagatedAttributes();
  const merged: PropagatedAttributes = {
    ...current,
    ...attributes,
    metadata: {
      ...(current.metadata ?? {}),
      ...(attributes.metadata ?? {}),
    },
    tags: attributes.tags ?? current.tags,
  };
  const nextCtx = setSessionBaggage(context.active(), merged.sessionId);
  return context.with(nextCtx, () => storage.run(merged, fn));
}

function readExplicitSessionAttribute(
  attrs: Record<string, unknown> | undefined,
): string | undefined {
  if (!attrs) return undefined;
  for (const key of EXPLICIT_SESSION_ATTR_KEYS) {
    const valid = normalizeValidSessionId(attrs[key]);
    if (valid) return valid;
  }
  return undefined;
}

function hasExplicitSessionAttribute(
  attrs: Record<string, unknown> | undefined,
): boolean {
  if (!attrs) return false;
  for (const key of EXPLICIT_SESSION_ATTR_KEYS) {
    const val = attrs[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return true;
    }
  }
  return false;
}

export class BaggageSessionSpanProcessor implements SpanProcessor {
  onStart(
    span: Span & { readonly attributes?: Record<string, unknown> },
    parentContext: Context,
  ): void {
    if (hasExplicitSessionAttribute(span.attributes)) {
      return;
    }
    const sessionId =
      normalizeValidSessionId(storage.getStore()?.sessionId) ??
      getBaggageSessionId(parentContext);
    if (!sessionId) {
      return;
    }
    span.setAttribute("sp.session.id", sessionId);
    span.setAttribute("gen_ai.conversation.id", sessionId);
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
