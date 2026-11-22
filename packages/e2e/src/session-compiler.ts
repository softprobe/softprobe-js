import { createHash } from "node:crypto";
import { AgentError, type AgentConfig, type ModelInstance } from "e2e";
import { z } from "zod";
import { parseBlackboxTracePayload } from "./internal/blackbox-sink.js";
import {
  formatAuthHeader,
  isJsonValue,
  parseJsonBodyValue,
  SinkHttpError,
  stripSpJsonPrefix,
} from "./internal/sink-shared.js";
import {
  isSpanId,
  isTraceId,
  type JsonValue,
  type OutboundHttpCall,
  type SpanId,
  type TraceId,
} from "./types.js";

export const UI_ACTION_SCHEMA_VERSION = "sp-ui-action-1" as const;
export const E2E_TRACE_SCHEMA_VERSION = "trace-1" as const;
export const E2E_REPLAY_POLICY_VERSION = "conservative/6" as const;
export const E2E_ENGINE_SPI_VERSION = 1 as const;

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
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
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
  | {
      readonly name: "navigate";
      readonly url: string;
      readonly trigger: "load" | "pushState" | "popstate";
    }
  | {
      readonly name: "click" | "dblclick" | "contextmenu" | "hover";
      readonly target: SemanticTarget;
      readonly modifiers?: readonly SemanticModifierKey[];
      readonly point: { readonly x: number; readonly y: number };
    }
  | {
      readonly name: "fill";
      readonly target: SemanticTarget;
      readonly value: CapturedInputValue;
      readonly replace: boolean;
    }
  | {
      readonly name: "select";
      readonly target: SemanticTarget;
      readonly value: CapturedInputValue;
      readonly optionLabel?: string;
    }
  | {
      readonly name: "check";
      readonly target: SemanticTarget;
      readonly checked: boolean;
    }
  | {
      readonly name: "press";
      readonly target?: SemanticTarget;
      readonly key: string;
      readonly modifiers?: readonly SemanticModifierKey[];
    }
  | {
      readonly name: "upload";
      readonly target: SemanticTarget;
      readonly fileNames: readonly string[];
      readonly mimeTypes: readonly string[];
    }
  | {
      readonly name: "drag";
      readonly source: SemanticTarget;
      readonly destination: SemanticTarget;
    }
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
  | {
      readonly name: "resize";
      readonly viewport: { readonly width: number; readonly height: number };
    };

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

const capturedInputValueSchema: z.ZodType<CapturedInputValue> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("literal"), value: z.string() }),
    z.object({ kind: z.literal("secret"), slot: z.string().min(1) }),
    z.object({ kind: z.literal("redacted"), length: z.number().int().nonnegative() }),
  ],
);

const modifierKeySchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
const anchorStateSchema = z.enum(["checked", "expanded", "pressed", "selected"]);

export const semanticTargetSchema: z.ZodType<SemanticTarget> = z.object({
  testId: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  text: z.string().optional(),
  inputPurpose: z.string().optional(),
  cssSelector: z.string().optional(),
  within: z.string().optional(),
  position: z
    .object({
      index: z.number().int().nonnegative(),
      of: z.number().int().positive(),
    })
    .optional(),
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  pointOffset: z
    .object({
      fx: z.number(),
      fy: z.number(),
    })
    .optional(),
  framePath: z.array(z.string()).optional(),
  rrwebNodeId: z.number().int().nonnegative().optional(),
  states: z.array(anchorStateSchema).optional(),
  value: z.string().optional(),
});

export const causedHttpTraceSchema: z.ZodType<CausedHttpTrace> = z.object({
  traceId: z.string().min(1),
  spanId: z.string().optional(),
  method: z.string().min(1),
  url: z.string().min(1),
  urlTemplate: z.string().optional(),
  status: z.number().int().optional(),
});

export const semanticVerbSchema: z.ZodType<SemanticVerb> = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("navigate"),
    url: z.string().min(1),
    trigger: z.enum(["load", "pushState", "popstate"]),
  }),
  z.object({
    name: z.literal("click"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("dblclick"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("contextmenu"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("hover"),
    target: semanticTargetSchema,
    modifiers: z.array(modifierKeySchema).optional(),
    point: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    name: z.literal("fill"),
    target: semanticTargetSchema,
    value: capturedInputValueSchema,
    replace: z.boolean(),
  }),
  z.object({
    name: z.literal("select"),
    target: semanticTargetSchema,
    value: capturedInputValueSchema,
    optionLabel: z.string().optional(),
  }),
  z.object({
    name: z.literal("check"),
    target: semanticTargetSchema,
    checked: z.boolean(),
  }),
  z.object({
    name: z.literal("press"),
    target: semanticTargetSchema.optional(),
    key: z.string().min(1),
    modifiers: z.array(modifierKeySchema).optional(),
  }),
  z.object({
    name: z.literal("upload"),
    target: semanticTargetSchema,
    fileNames: z.array(z.string()),
    mimeTypes: z.array(z.string()),
  }),
  z.object({
    name: z.literal("drag"),
    source: semanticTargetSchema,
    destination: semanticTargetSchema,
  }),
  z.object({
    name: z.literal("scroll"),
    target: semanticTargetSchema.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    times: z.number().int().positive(),
    spansViewport: z.number(),
  }),
  z.object({
    name: z.literal("dialog"),
    dialogType: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    accepted: z.boolean(),
    promptText: capturedInputValueSchema.optional(),
  }),
  z.object({
    name: z.literal("resize"),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
]);

export const recordedSemanticActionSchema: z.ZodType<RecordedSemanticAction> = z.object({
  schemaVersion: z.literal(UI_ACTION_SCHEMA_VERSION),
  actionIndex: z.number().int().nonnegative(),
  timestampMs: z.number(),
  startPath: z.string(),
  endPath: z.string(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  verb: semanticVerbSchema,
  causedTraces: z.array(causedHttpTraceSchema),
  endAnchors: z.array(semanticTargetSchema),
  goneAnchors: z.array(semanticTargetSchema),
  settleMs: z.number().nonnegative(),
});

export interface CompiledDynamicTextMatch {
  readonly literal: string;
  readonly patternSource: string;
  readonly derivedFromTraceId: string;
  readonly matchedScalars: readonly string[];
}

export type CompiledPathMatcher =
  | { readonly kind: "exact"; readonly pathname: string }
  | { readonly kind: "regex"; readonly patternSource: string };

export interface CompiledBackendTrace {
  readonly traceId: TraceId;
  readonly triggerMethod: string;
  readonly triggerPath: string;
  readonly triggerPathMatcher: CompiledPathMatcher;
  readonly triggerUrl: string;
  readonly urlTemplate?: string;
  readonly triggerStatus?: number;
  readonly serverServiceName?: string;
  readonly serverRoute?: string;
  readonly serverStatus?: number;
  readonly outboundCalls: readonly OutboundHttpCall[];
}

export interface CompiledSessionStep {
  readonly stepIndex: number;
  readonly action: RecordedSemanticAction;
  readonly summary: string;
  readonly dynamicNamePattern?: CompiledDynamicTextMatch;
  readonly dynamicTextPattern?: CompiledDynamicTextMatch;
  readonly backendTraces: readonly CompiledBackendTrace[];
}

export interface CompiledSessionBundle {
  readonly sessionId: string;
  readonly baseOrigin?: string;
  readonly steps: readonly CompiledSessionStep[];
  readonly secretSlots: readonly string[];
  readonly outboundAssertionCount: number;
}

export interface ExtractSessionBundleOptions {
  readonly sessionId?: string;
  readonly baseOrigin?: string;
  readonly explorerUrl?: string;
  readonly tracesByTraceId?: Readonly<Record<string, unknown>>;
}

const rawKeyValueSchema = z.object({
  key: z.string(),
  value: z.unknown().optional(),
});

const rawAnyValueSchema = z.object({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
  arrayValue: z.object({ values: z.array(z.unknown()).optional() }).optional(),
  kvlistValue: z.object({ values: z.array(z.unknown()).optional() }).optional(),
});

const rawSpanObjectSchema = z.object({
  traceId: z.unknown().optional(),
  trace_id: z.unknown().optional(),
  spanId: z.unknown().optional(),
  span_id: z.unknown().optional(),
  parentSpanId: z.unknown().optional(),
  parent_span_id: z.unknown().optional(),
  session_id: z.string().nullable().optional(),
  name: z.string().optional(),
  kind: z.unknown().optional(),
  span_kind: z.unknown().optional(),
  span_type: z.string().optional(),
  observation_type: z.string().optional(),
  service_name: z.string().nullable().optional(),
  startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  endTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  start_time: z.string().optional(),
  end_time: z.string().nullable().optional(),
  attributes: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  resource_attributes: z
    .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
    .optional(),
  events: z.array(z.unknown()).optional(),
});

const rawScopeSpansSchema = z.object({
  spans: z.array(rawSpanObjectSchema).optional(),
});

const rawResourceSpansSchema = z.object({
  resource: z
    .object({
      attributes: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
    })
    .optional(),
  scopeSpans: z.array(rawScopeSpansSchema).optional(),
  instrumentationLibrarySpans: z.array(rawScopeSpansSchema).optional(),
});

const rawSessionInputEnvelopeSchema = z.object({
  session_id: z.string().optional(),
  sessionId: z.string().optional(),
  spans: z.array(rawSpanObjectSchema).optional(),
  observations: z.array(rawSpanObjectSchema).optional(),
  resourceSpans: z.array(rawResourceSpansSchema).optional(),
  batches: z.array(rawResourceSpansSchema).optional(),
  trace: z
    .object({
      resourceSpans: z.array(rawResourceSpansSchema).optional(),
    })
    .optional(),
  traces: z.record(z.string(), z.unknown()).optional(),
  tracesByTraceId: z.record(z.string(), z.unknown()).optional(),
});

interface NormalizedRawSpan {
  readonly raw: z.infer<typeof rawSpanObjectSchema>;
  readonly traceId: TraceId | null;
  readonly spanId: SpanId | null;
  readonly sessionId: string | undefined;
  readonly name: string;
  readonly startMs: number;
  readonly attributes: Readonly<Record<string, string>>;
  readonly resourceAttributes: Readonly<Record<string, string>>;
}

function decodeHexId(raw: unknown, byteLen: 16 | 8): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length === byteLen * 2 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === byteLen) return buf.toString("hex").toLowerCase();
  } catch {}
  return "";
}

function stringifyAnyVal(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  const parsed = rawAnyValueSchema.safeParse(raw);
  if (!parsed.success) {
    return isJsonValue(raw) ? JSON.stringify(raw) : "";
  }
  const v = parsed.data;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.intValue === "string" || typeof v.intValue === "number") return String(v.intValue);
  if (typeof v.doubleValue === "number") return String(v.doubleValue);
  if (typeof v.boolValue === "boolean") return String(v.boolValue);
  if (Array.isArray(v.arrayValue?.values)) {
    return JSON.stringify(v.arrayValue.values.map(stringifyAnyVal));
  }
  if (Array.isArray(v.kvlistValue?.values)) {
    const out: Record<string, string> = {};
    for (const item of v.kvlistValue.values) {
      const kv = rawKeyValueSchema.safeParse(item);
      if (kv.success) out[kv.data.key] = stringifyAnyVal(kv.data.value);
    }
    return JSON.stringify(out);
  }
  return "";
}

function normalizeAttributes(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const item of raw) {
      const kv = rawKeyValueSchema.safeParse(item);
      if (kv.success) out[kv.data.key] = stringifyAnyVal(kv.data.value);
    }
    return out;
  }
  if (raw !== null && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined && v !== null) out[k] = stringifyAnyVal(v);
    }
    return out;
  }
  return {};
}

function parseTimestampMs(
  nanoRaw: string | number | undefined,
  isoRaw: string | undefined,
): number {
  if (typeof nanoRaw === "number") {
    if (Number.isFinite(nanoRaw) && nanoRaw > 0) {
      return Math.trunc(nanoRaw / 1_000_000);
    }
  } else if (typeof nanoRaw === "string") {
    const trimmed = nanoRaw.trim();
    if (/^\d+$/.test(trimmed)) {
      try {
        return Number(BigInt(trimmed) / 1_000_000n);
      } catch {}
    } else if (trimmed !== "") {
      const parsedNum = Number(trimmed);
      if (Number.isFinite(parsedNum) && parsedNum > 0) {
        return Math.trunc(parsedNum / 1_000_000);
      }
    }
  }
  if (isoRaw) {
    const parsed = Date.parse(isoRaw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

const TRIVIAL_RESPONSE_WORDS = new Set([
  "true",
  "false",
  "null",
  "ok",
  "yes",
  "no",
  "idle",
  "ready",
  "done",
  "error",
  "success",
  "pending",
  "active",
  "admin",
  "user",
  "member",
  "usd",
  "eur",
  "gbp",
]);

function isNonTrivialDynamicScalar(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > 120) return false;
  if (TRIVIAL_RESPONSE_WORDS.has(trimmed.toLowerCase())) return false;
  if (/\d/.test(trimmed)) return true;
  return trimmed.length >= 6 && /[A-Za-z]/.test(trimmed) && /[A-Z0-9_-]/.test(trimmed);
}

function collectResponseJsonScalars(
  value: JsonValue | undefined,
  sink: Set<string>,
  depth = 0,
): void {
  if (value === undefined || value === null || depth > 8) return;
  if (typeof value === "string") {
    if (isNonTrivialDynamicScalar(value)) {
      sink.add(value.trim());
    }
    return;
  }
  if (typeof value === "number") {
    const formatted = String(value);
    if (formatted.length >= 3) {
      sink.add(formatted);
    }
    if (!Number.isInteger(value)) {
      const fixed2 = value.toFixed(2);
      if (fixed2.length >= 4) sink.add(fixed2);
    }
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) collectResponseJsonScalars(item, sink, depth + 1);
    return;
  }
  for (const entry of Object.values(value)) {
    collectResponseJsonScalars(entry, sink, depth + 1);
  }
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectDynamicTextPattern(
  candidateText: string | undefined,
  priorScalarsByTrace: ReadonlyArray<{
    readonly traceId: string;
    readonly scalars: ReadonlySet<string>;
  }>,
): CompiledDynamicTextMatch | undefined {
  if (!candidateText || candidateText.trim().length < 4) return undefined;
  const matchedEntries: Array<{ readonly scalar: string; readonly traceId: string }> = [];

  for (const source of priorScalarsByTrace) {
    for (const scalar of source.scalars) {
      if (candidateText.length > scalar.length && candidateText.includes(scalar)) {
        matchedEntries.push({ scalar, traceId: source.traceId });
      }
    }
  }
  if (matchedEntries.length === 0) return undefined;

  const uniqueScalars = [...new Set(matchedEntries.map((m) => m.scalar))].sort(
    (a, b) => b.length - a.length,
  );

  interface SpanRange {
    readonly start: number;
    readonly end: number;
    readonly scalar: string;
  }
  const ranges: SpanRange[] = [];
  for (const scalar of uniqueScalars) {
    let fromIdx = 0;
    while (fromIdx < candidateText.length) {
      const found = candidateText.indexOf(scalar, fromIdx);
      if (found === -1) break;
      const end = found + scalar.length;
      const overlaps = ranges.some((r) => found < r.end && end > r.start);
      if (!overlaps) {
        ranges.push({ start: found, end, scalar });
      }
      fromIdx = end;
    }
  }
  if (ranges.length === 0) return undefined;
  ranges.sort((a, b) => a.start - b.start);

  let patternBody = "";
  let cursor = 0;
  for (const range of ranges) {
    patternBody += escapeRegExpLiteral(candidateText.slice(cursor, range.start));
    patternBody += ".*";
    cursor = range.end;
  }
  patternBody += escapeRegExpLiteral(candidateText.slice(cursor));

  return {
    literal: candidateText,
    patternSource: `^${patternBody}$`,
    derivedFromTraceId: matchedEntries[0]!.traceId,
    matchedScalars: ranges.map((r) => r.scalar),
  };
}

const COLON_PARAM_SEGMENT_RE = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const BRACE_PARAM_SEGMENT_RE = /^\{[^/}]+\}$/;

function extractRouteTemplatePathname(rawTemplate: string): string | undefined {
  const trimmed = rawTemplate.trim();
  if (!trimmed) return undefined;
  let candidate = trimmed;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) {
    const schemeEnd = trimmed.indexOf("://") + 3;
    const slashIdx = trimmed.indexOf("/", schemeEnd);
    const queryOrHashIdx = trimmed.slice(schemeEnd).search(/[?#]/);
    if (slashIdx >= 0 && (queryOrHashIdx === -1 || slashIdx < schemeEnd + queryOrHashIdx)) {
      candidate = trimmed.slice(slashIdx);
    } else {
      candidate = "/";
    }
  } else if (!trimmed.startsWith("/")) {
    const methodStripped = trimmed.replace(/^[A-Z]+\s+/, "").trim();
    if (!methodStripped.startsWith("/")) return undefined;
    candidate = methodStripped;
  }
  const withoutHash = (candidate.split("#")[0] ?? "/").trim();
  const withoutQuery = (withoutHash.split("?")[0] ?? "/").trim();
  if (withoutQuery === "" || withoutQuery === "/") return "/";
  return `/${withoutQuery.replace(/^\/+|\/+$/g, "")}`;
}

function compileRouteTemplateRegexSource(rawTemplate: string): string | undefined {
  const pathname = extractRouteTemplatePathname(rawTemplate);
  if (!pathname || pathname === "/") return undefined;
  const segments = pathname.slice(1).split("/");
  let hasDynamicSegment = false;
  const compiled = segments.map((seg) => {
    if (seg === "**") {
      hasDynamicSegment = true;
      return ".*";
    }
    if (COLON_PARAM_SEGMENT_RE.test(seg) || BRACE_PARAM_SEGMENT_RE.test(seg)) {
      hasDynamicSegment = true;
      return "[^/]+";
    }
    if (seg.includes("*")) {
      hasDynamicSegment = true;
      let out = "";
      for (const ch of seg) {
        out += ch === "*" ? "[^/]*" : escapeRegExpLiteral(ch);
      }
      return out;
    }
    return escapeRegExpLiteral(seg);
  });
  if (!hasDynamicSegment) return undefined;
  return `^\\/${compiled.join("\\/")}\\/?$`;
}

function detectDynamicPathRegexSource(
  triggerPath: string,
  priorScalarsByTrace: ReadonlyArray<{
    readonly traceId: string;
    readonly scalars: ReadonlySet<string>;
  }>,
): string | undefined {
  if (!triggerPath || triggerPath === "/") return undefined;
  const normalized = `/${triggerPath.replace(/^\/+|\/+$/g, "")}`;
  const allScalars = new Set<string>();
  for (const entry of priorScalarsByTrace) {
    for (const s of entry.scalars) {
      if (!s.includes("/")) allScalars.add(s);
    }
  }
  if (allScalars.size === 0) return undefined;
  const sortedScalars = [...allScalars].sort((a, b) => b.length - a.length);

  let matchedAny = false;
  const compiledSegments = normalized
    .slice(1)
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      const exactMatch = sortedScalars.find((sc) => segment === sc);
      if (exactMatch !== undefined) {
        matchedAny = true;
        return "[^/]+";
      }
      const subMatch = detectDynamicTextPattern(segment, [
        { traceId: "path", scalars: allScalars },
      ]);
      if (subMatch) {
        matchedAny = true;
        return subMatch.patternSource
          .replace(/^\^/, "")
          .replace(/\$$/, "")
          .replaceAll(".*", "[^/]+");
      }
      return escapeRegExpLiteral(segment);
    });

  if (!matchedAny) return undefined;
  return `^\\/${compiledSegments.join("\\/")}\\/?$`;
}

function resolveTriggerPathMatcher(
  triggerPath: string,
  urlTemplate: string | undefined,
  serverRoute: string | undefined,
  priorScalarsByTrace: ReadonlyArray<{
    readonly traceId: string;
    readonly scalars: ReadonlySet<string>;
  }>,
): CompiledPathMatcher {
  for (const candidateTemplate of [urlTemplate, serverRoute]) {
    if (!candidateTemplate) continue;
    const regexSource = compileRouteTemplateRegexSource(candidateTemplate);
    if (regexSource && new RegExp(regexSource).test(triggerPath)) {
      return { kind: "regex", patternSource: regexSource };
    }
  }
  const dynamicScalarSource = detectDynamicPathRegexSource(triggerPath, priorScalarsByTrace);
  if (dynamicScalarSource && new RegExp(dynamicScalarSource).test(triggerPath)) {
    return { kind: "regex", patternSource: dynamicScalarSource };
  }
  return { kind: "exact", pathname: triggerPath };
}

function allocateDisambiguatedIdentifiers(
  slots: readonly string[],
  normalize: (slot: string) => string,
): ReadonlyMap<string, string> {
  const uniqueSorted = [...new Set(slots)].sort(compareCodeUnits);
  const used = new Set<string>();
  const mapping = new Map<string, string>();
  for (const slot of uniqueSorted) {
    const rawBase = normalize(slot);
    const base = rawBase.length > 0 ? rawBase : "slot";
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    mapping.set(slot, candidate);
  }
  return mapping;
}

function allocatePlaywrightSecretVars(slots: readonly string[]): ReadonlyMap<string, string> {
  return allocateDisambiguatedIdentifiers(
    slots,
    (slot) => `secret_${slot.replace(/[^A-Za-z0-9_]/g, "_") || "slot"}`,
  );
}

function allocateE2ESecretParamKeys(slots: readonly string[]): ReadonlyMap<string, string> {
  return allocateDisambiguatedIdentifiers(
    slots,
    (slot) => slot.toLowerCase().replace(/[^a-z0-9_]/g, "_") || "secret",
  );
}

function extractVerbPrimaryTarget(verb: SemanticVerb): SemanticTarget | undefined {
  switch (verb.name) {
    case "click":
    case "dblclick":
    case "contextmenu":
    case "hover":
    case "fill":
    case "select":
    case "check":
    case "upload":
      return verb.target;
    case "press":
    case "scroll":
      return verb.target;
    case "drag":
      return verb.source;
    case "navigate":
    case "dialog":
    case "resize":
      return undefined;
    default: {
      const _exhaustive: never = verb;
      return _exhaustive;
    }
  }
}

function collectActionSecretSlots(verb: SemanticVerb, sink: Set<string>): void {
  if (
    (verb.name === "fill" || verb.name === "select") &&
    verb.value.kind === "secret"
  ) {
    sink.add(verb.value.slot);
  }
  if (verb.name === "dialog" && verb.promptText?.kind === "secret") {
    sink.add(verb.promptText.slot);
  }
}

export function extractSessionBundleFromSpans(
  rawInput: unknown,
  options: ExtractSessionBundleOptions = {},
): CompiledSessionBundle {
  const normalizedSpans: NormalizedRawSpan[] = [];
  let envelopeSessionId: string | undefined;
  const extraTraces: Record<string, unknown> = {
    ...(options.tracesByTraceId ?? {}),
  };

  const pushRaw = (
    item: z.infer<typeof rawSpanObjectSchema>,
    resAttrs: Readonly<Record<string, string>>,
  ) => {
    const attrs = normalizeAttributes(item.attributes);
    const inlineResAttrs = normalizeAttributes(item.resource_attributes);
    const combinedRes = { ...resAttrs, ...inlineResAttrs };
    const traceHex = decodeHexId(item.traceId ?? item.trace_id, 16);
    const spanHex = decodeHexId(item.spanId ?? item.span_id, 8);
    const sessionId =
      item.session_id?.trim() ||
      attrs["sp.session.id"]?.trim() ||
      attrs["session.id"]?.trim() ||
      undefined;
    normalizedSpans.push({
      raw: item,
      traceId: isTraceId(traceHex) ? traceHex : null,
      spanId: isSpanId(spanHex) ? spanHex : null,
      sessionId,
      name: item.name ?? "span",
      startMs: parseTimestampMs(item.startTimeUnixNano, item.start_time),
      attributes: attrs,
      resourceAttributes: combinedRes,
    });
  };

  if (Array.isArray(rawInput)) {
    for (const entry of rawInput) {
      const parsed = rawSpanObjectSchema.safeParse(entry);
      if (parsed.success) pushRaw(parsed.data, {});
    }
  } else {
    const envParsed = rawSessionInputEnvelopeSchema.safeParse(rawInput);
    if (!envParsed.success) {
      throw new Error(
        `Invalid session spans input: ${envParsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const data = envParsed.data;
    envelopeSessionId = data.sessionId ?? data.session_id;
    Object.assign(extraTraces, data.traces ?? {}, data.tracesByTraceId ?? {});

    for (const rs of [
      ...(data.trace?.resourceSpans ?? []),
      ...(data.batches ?? []),
      ...(data.resourceSpans ?? []),
    ]) {
      const resAttrs = normalizeAttributes(rs.resource?.attributes);
      for (const scope of [
        ...(rs.scopeSpans ?? []),
        ...(rs.instrumentationLibrarySpans ?? []),
      ]) {
        for (const sp of scope.spans ?? []) {
          pushRaw(sp, resAttrs);
        }
      }
    }
    for (const sp of [...(data.spans ?? []), ...(data.observations ?? [])]) {
      pushRaw(sp, {});
    }
  }

  const resolvedSessionId =
    options.sessionId?.trim() ||
    envelopeSessionId?.trim() ||
    normalizedSpans.find((s) => s.sessionId !== undefined)?.sessionId ||
    "recorded-session";

  const uiActionServiceNames = new Set<string>();
  const uiActionEntries: Array<{
    action: RecordedSemanticAction;
    readonly summary: string;
  }> = [];

  const readSpanServiceName = (span: NormalizedRawSpan): string | undefined =>
    span.raw.service_name?.trim() ||
    span.resourceAttributes["service.name"]?.trim() ||
    span.attributes["service.name"]?.trim() ||
    span.attributes["service_name"]?.trim() ||
    undefined;

  for (const span of normalizedSpans) {
    const isUiAction =
      span.name === "softprobe.ui.action" ||
      span.attributes["sp.observation.type"] === "ui_action";
    if (!isUiAction) continue;

    const svcName = readSpanServiceName(span);
    if (svcName) uiActionServiceNames.add(svcName);

    const payloadRaw = span.attributes["sp.ui.action.payload"];
    if (!payloadRaw) {
      throw new Error(
        `softprobe.ui.action span ${span.spanId ?? "unknown"} is missing sp.ui.action.payload`,
      );
    }
    let decodedJson: unknown;
    try {
      decodedJson = JSON.parse(stripSpJsonPrefix(payloadRaw));
    } catch (err) {
      throw new Error(
        `Invalid JSON in sp.ui.action.payload on span ${span.spanId ?? "unknown"}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const validated = recordedSemanticActionSchema.safeParse(decodedJson);
    if (!validated.success) {
      throw new Error(
        `Invalid sp-ui-action-1 payload on span ${span.spanId ?? "unknown"}: ${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    const summary =
      span.attributes["sp.ui.action.summary"]?.trim() ||
      validated.data.verb.name;
    uiActionEntries.push({ action: validated.data, summary });
  }

  uiActionEntries.sort((a, b) => {
    if (a.action.actionIndex !== b.action.actionIndex) {
      return a.action.actionIndex - b.action.actionIndex;
    }
    return a.action.timestampMs - b.action.timestampMs;
  });

  const claimedTraceIds = new Set<string>();
  for (const entry of uiActionEntries) {
    for (const ct of entry.action.causedTraces) {
      claimedTraceIds.add(ct.traceId.trim().toLowerCase());
    }
  }

  const candidateBrowserHttpSpans = normalizedSpans
    .filter((span) => {
      if (!span.traceId || claimedTraceIds.has(span.traceId) || span.startMs <= 0) {
        return false;
      }
      const obsType = span.attributes["sp.observation.type"] ?? span.attributes["observation_type"];
      if (
        span.name === "softprobe.ui.action" ||
        span.name === "softprobe.web.recording" ||
        span.name === "softprobe.http.body.capture" ||
        obsType === "ui_action" ||
        obsType === "recording" ||
        obsType === "http_body"
      ) {
        return false;
      }
      const parentHex = decodeHexId(span.raw.parentSpanId ?? span.raw.parent_span_id, 8);
      if (isSpanId(parentHex)) return false;
      const rawKind = span.raw.kind ?? span.raw.span_kind;
      if (rawKind === 2 || rawKind === "SERVER" || rawKind === "SPAN_KIND_SERVER") {
        return false;
      }
      const url = (span.attributes["url.full"] ?? span.attributes["http.url"] ?? "").trim();
      if (!url) return false;
      const svcName = readSpanServiceName(span);
      if (uiActionServiceNames.size > 0 && svcName && !uiActionServiceNames.has(svcName)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.startMs - b.startMs);

  const eligibleActionIndices = uiActionEntries
    .map((entry, idx) =>
      entry.action.verb.name !== "resize" && entry.action.verb.name !== "dialog" ? idx : -1,
    )
    .filter((idx) => idx >= 0);

  const inferredByActionIndex = new Map<number, CausedHttpTrace[]>();

  for (const httpSpan of candidateBrowserHttpSpans) {
    if (!httpSpan.traceId || claimedTraceIds.has(httpSpan.traceId)) continue;
    const url = (httpSpan.attributes["url.full"] ?? httpSpan.attributes["http.url"] ?? "").trim();
    const method = (
      httpSpan.attributes["http.request.method"] ??
      httpSpan.attributes["http.method"] ??
      httpSpan.name
    )
      .trim()
      .toUpperCase();
    if (!url || !method) continue;

    let chosenIdx = -1;
    let prevPos = -1;
    for (let p = 0; p < eligibleActionIndices.length; p += 1) {
      const idx = eligibleActionIndices[p]!;
      if (uiActionEntries[idx]!.action.timestampMs <= httpSpan.startMs) {
        prevPos = p;
      } else {
        break;
      }
    }

    const nextPos = prevPos + 1;
    if (nextPos < eligibleActionIndices.length) {
      const nextIdx = eligibleActionIndices[nextPos]!;
      const nextAction = uiActionEntries[nextIdx]!.action;
      const prevSettled =
        prevPos < 0 ||
        httpSpan.startMs >
          uiActionEntries[eligibleActionIndices[prevPos]!]!.action.timestampMs +
            uiActionEntries[eligibleActionIndices[prevPos]!]!.action.settleMs;
      if (prevSettled && nextAction.timestampMs - httpSpan.startMs <= 50) {
        chosenIdx = nextIdx;
      }
    }

    if (chosenIdx < 0 && prevPos >= 0) {
      const prevIdx = eligibleActionIndices[prevPos]!;
      const prevAction = uiActionEntries[prevIdx]!.action;
      if (httpSpan.startMs <= prevAction.timestampMs + Math.max(prevAction.settleMs, 15_000)) {
        chosenIdx = prevIdx;
      }
    }

    if (chosenIdx < 0) continue;
    const targetEntry = uiActionEntries[chosenIdx]!;
    if (targetEntry.action.causedTraces.length > 0) continue;

    const rawStatus =
      httpSpan.attributes["http.response.status_code"] ?? httpSpan.attributes["http.status_code"];
    const parsedStatus = rawStatus ? Number.parseInt(rawStatus, 10) : Number.NaN;
    const urlTemplate = httpSpan.attributes["url.template"]?.trim() || undefined;
    claimedTraceIds.add(httpSpan.traceId);
    const list = inferredByActionIndex.get(chosenIdx) ?? [];
    list.push({
      traceId: httpSpan.traceId,
      ...(httpSpan.spanId ? { spanId: httpSpan.spanId } : {}),
      method,
      url,
      ...(urlTemplate ? { urlTemplate } : {}),
      ...(Number.isInteger(parsedStatus) && parsedStatus >= 0 ? { status: parsedStatus } : {}),
    });
    inferredByActionIndex.set(chosenIdx, list);
  }

  for (const [idx, inferredTraces] of inferredByActionIndex.entries()) {
    const entry = uiActionEntries[idx];
    if (entry && inferredTraces.length > 0) {
      entry.action = {
        ...entry.action,
        causedTraces: inferredTraces,
      };
    }
  }

  const rawSpansByTraceId = new Map<TraceId, Array<z.infer<typeof rawSpanObjectSchema>>>();
  const responseScalarsByTraceId = new Map<string, Set<string>>();

  for (const span of normalizedSpans) {
    if (span.traceId) {
      const bucket = rawSpansByTraceId.get(span.traceId) ?? [];
      bucket.push({
        ...span.raw,
        resource_attributes: {
          ...span.resourceAttributes,
          ...(typeof span.raw.resource_attributes === "object" &&
          span.raw.resource_attributes !== null &&
          !Array.isArray(span.raw.resource_attributes)
            ? span.raw.resource_attributes
            : {}),
        },
      });
      rawSpansByTraceId.set(span.traceId, bucket);

      const rawResp =
        span.attributes["http.response.body.content"] ??
        span.attributes["http.response.body"] ??
        span.attributes["sp.http.response.body"];
      if (rawResp) {
        const parsedJson = parseJsonBodyValue(rawResp);
        if (parsedJson !== undefined) {
          const scalarSet = responseScalarsByTraceId.get(span.traceId) ?? new Set<string>();
          collectResponseJsonScalars(parsedJson, scalarSet);
          if (scalarSet.size > 0) {
            responseScalarsByTraceId.set(span.traceId, scalarSet);
          }
        }
      }
    }
  }

  let inferredOrigin = options.baseOrigin?.trim();
  const secretSlots = new Set<string>();
  const priorTracesSeen = new Set<string>();
  let outboundAssertionCount = 0;

  const steps: CompiledSessionStep[] = uiActionEntries.map((entry, idx) => {
    const { action, summary } = entry;
    collectActionSecretSlots(action.verb, secretSlots);

    for (const span of normalizedSpans) {
      if (
        span.traceId &&
        span.startMs > 0 &&
        span.startMs < action.timestampMs &&
        !action.causedTraces.some((ct) => ct.traceId === span.traceId)
      ) {
        priorTracesSeen.add(span.traceId);
      }
    }

    const priorScalarSources = [...priorTracesSeen]
      .map((tid) => {
        const scalars = responseScalarsByTraceId.get(tid);
        return scalars ? { traceId: tid, scalars } : undefined;
      })
      .filter((x): x is { traceId: string; scalars: Set<string> } => x !== undefined);

    const target = extractVerbPrimaryTarget(action.verb);
    const dynamicNamePattern = detectDynamicTextPattern(target?.name, priorScalarSources);
    const dynamicTextPattern = detectDynamicTextPattern(target?.text, priorScalarSources);

    const backendTraces: CompiledBackendTrace[] = [];
    for (const ct of action.causedTraces) {
      priorTracesSeen.add(ct.traceId);
      let triggerPath = ct.url;
      try {
        const parsedUrl = new URL(ct.url);
        if (!inferredOrigin) inferredOrigin = parsedUrl.origin;
        triggerPath = parsedUrl.pathname || "/";
      } catch {
        triggerPath = (ct.url.split("?")[0] ?? "/") || "/";
      }

      const traceIdLower = ct.traceId.trim().toLowerCase();
      if (!isTraceId(traceIdLower)) continue;

      let snapshot = extraTraces[traceIdLower] !== undefined
        ? parseBlackboxTracePayload(traceIdLower, extraTraces[traceIdLower], options.explorerUrl)
        : undefined;

      if ((!snapshot || snapshot.state !== "ingested") && rawSpansByTraceId.has(traceIdLower)) {
        snapshot = parseBlackboxTracePayload(
          traceIdLower,
          { spans: rawSpansByTraceId.get(traceIdLower) },
          options.explorerUrl,
        );
      }

      const outboundCalls = snapshot?.state === "ingested" ? snapshot.outboundHttp : [];
      outboundAssertionCount += outboundCalls.length;
      const serverRoute =
        snapshot?.state === "ingested" ? snapshot.serverEntry.routeOrPath : undefined;
      const triggerPathMatcher = resolveTriggerPathMatcher(
        triggerPath,
        ct.urlTemplate,
        serverRoute,
        priorScalarSources,
      );

      backendTraces.push({
        traceId: traceIdLower,
        triggerMethod: ct.method.toUpperCase(),
        triggerPath,
        triggerPathMatcher,
        triggerUrl: ct.url,
        ...(ct.urlTemplate ? { urlTemplate: ct.urlTemplate } : {}),
        ...(ct.status !== undefined ? { triggerStatus: ct.status } : {}),
        ...(snapshot?.state === "ingested"
          ? {
              serverServiceName: snapshot.serverEntry.serviceName,
              ...(serverRoute ? { serverRoute } : {}),
              ...(snapshot.serverEntry.status !== undefined
                ? { serverStatus: snapshot.serverEntry.status }
                : {}),
            }
          : {}),
        outboundCalls,
      });
    }

    return {
      stepIndex: idx,
      action,
      summary,
      ...(dynamicNamePattern ? { dynamicNamePattern } : {}),
      ...(dynamicTextPattern ? { dynamicTextPattern } : {}),
      backendTraces,
    };
  });

  return {
    sessionId: resolvedSessionId,
    ...(inferredOrigin ? { baseOrigin: inferredOrigin } : {}),
    steps,
    secretSlots: [...secretSlots].sort(),
    outboundAssertionCount,
  };
}

export interface FetchSessionSpansOptions {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly token?: string;
  readonly workspaceId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly fetchImpl?: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  readonly signal?: AbortSignal;
}

export interface FetchedSessionPayload {
  readonly sessionId: string;
  readonly spans: readonly unknown[];
  readonly tracesByTraceId: Readonly<Record<string, unknown>>;
}

function buildSessionEndpointCandidates(rawEndpoint: string, sessionId: string, qs: string): string[] {
  const clean = rawEndpoint.trim().replace(/\/+$/, "");
  const encodedId = encodeURIComponent(sessionId);
  const suffix = qs ? `?${qs}` : "";
  const withLimit = qs ? `?${qs}&limit=500` : "?limit=500";
  const candidates: string[] = [];
  const add = (url: string) => {
    if (!candidates.includes(url)) candidates.push(url);
  };

  if (clean.endsWith("/api/thelake")) {
    add(`${clean}/v1/llm/sessions/${encodedId}${withLimit}`);
    add(`${clean}/v1/sessions/${encodedId}${withLimit}`);
    add(`${clean}/v1/llm/sessions/${encodedId}/spans${suffix}`);
  } else {
    add(`${clean}/api/thelake/v1/llm/sessions/${encodedId}${withLimit}`);
    add(`${clean}/api/thelake/v1/sessions/${encodedId}${withLimit}`);
    add(`${clean}/v1/sessions/${encodedId}${withLimit}`);
    add(`${clean}/v1/llm/sessions/${encodedId}${withLimit}`);
    add(`${clean}/api/thelake/v1/llm/sessions/${encodedId}/spans${suffix}`);
    add(`${clean}/v1/llm/sessions/${encodedId}/spans${suffix}`);
  }
  return candidates;
}

function buildTraceEndpointCandidates(rawEndpoint: string, traceId: string): string[] {
  const clean = rawEndpoint.trim().replace(/\/+$/, "");
  const encoded = encodeURIComponent(traceId);
  const candidates: string[] = [];
  const add = (url: string) => {
    if (!candidates.includes(url)) candidates.push(url);
  };
  if (clean.endsWith("/api/thelake")) {
    const explorerRoot = clean.slice(0, -"/api/thelake".length);
    add(`${clean}/v1/traces/${encoded}`);
    add(`${clean}/api/traces/${encoded}`);
    add(`${explorerRoot}/api/traces/${encoded}`);
    add(`${clean}/v1/llm/traces/${encoded}?limit=200`);
  } else {
    add(`${clean}/api/thelake/v1/traces/${encoded}`);
    add(`${clean}/api/thelake/api/traces/${encoded}`);
    add(`${clean}/v1/traces/${encoded}`);
    add(`${clean}/api/traces/${encoded}`);
    add(`${clean}/v1/llm/traces/${encoded}?limit=200`);
    add(`${clean}/api/thelake/v1/llm/traces/${encoded}?limit=200`);
  }
  return candidates;
}

// Explorer serves index.html with HTTP 200 on non-/api/ SPA routes, so skip HTML fallback responses while probing direct TheLake paths.
function isHtmlFallbackResponse(response: Response): boolean {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  return contentType.includes("text/html");
}

export async function fetchSessionSpansFromBlackbox(
  options: FetchSessionSpansOptions,
): Promise<FetchedSessionPayload> {
  const fetchFn = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...formatAuthHeader(options.token),
    ...(options.workspaceId ? { "X-Workspace-Id": options.workspaceId } : {}),
  };

  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  const qs = params.toString();

  const candidates = buildSessionEndpointCandidates(options.endpoint, options.sessionId, qs);
  let rawSessionBody: unknown;
  let lastStatus = 404;
  let lastUrl = candidates[0] ?? options.endpoint;

  for (const url of candidates) {
    lastUrl = url;
    const response = await fetchFn(url, {
      method: "GET",
      headers,
      signal: options.signal,
    });
    if (response.status === 404 || isHtmlFallbackResponse(response)) {
      lastStatus = 404;
      continue;
    }
    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 240);
      throw new SinkHttpError(
        `Session lookup GET ${url} failed with HTTP ${response.status}${snippet ? ` (${snippet})` : ""}`,
        response.status,
        response.status >= 500 || response.status === 429,
      );
    }
    rawSessionBody = await response.json();
    break;
  }

  if (rawSessionBody === undefined) {
    throw new SinkHttpError(
      `Session ${options.sessionId} not found at ${lastUrl} (HTTP ${lastStatus})`,
      lastStatus,
      false,
    );
  }

  const spans: unknown[] = Array.isArray(rawSessionBody)
    ? rawSessionBody
    : typeof rawSessionBody === "object" && rawSessionBody !== null
      ? "spans" in rawSessionBody && Array.isArray(rawSessionBody.spans)
        ? rawSessionBody.spans
        : "observations" in rawSessionBody && Array.isArray(rawSessionBody.observations)
          ? rawSessionBody.observations
          : []
      : [];

  const preliminaryInput =
    spans.length > 0 ? { sessionId: options.sessionId, spans } : rawSessionBody;
  const preliminarBundle = extractSessionBundleFromSpans(preliminaryInput, {
    sessionId: options.sessionId,
  });

  const traceIds = new Set<string>();
  for (const step of preliminarBundle.steps) {
    for (const ct of step.action.causedTraces) {
      const lower = ct.traceId.trim().toLowerCase();
      if (isTraceId(lower)) traceIds.add(lower);
    }
  }

  const tracesByTraceId: Record<string, unknown> = {};
  const orderedTraceIds = [...traceIds];
  let preferredCandidateIndex: number | null = null;

  const fetchSingleTrace = async (traceId: string): Promise<void> => {
    const candidates = buildTraceEndpointCandidates(options.endpoint, traceId);
    const candidateIndices = candidates.map((_, idx) => idx);
    if (
      preferredCandidateIndex !== null &&
      preferredCandidateIndex >= 0 &&
      preferredCandidateIndex < candidateIndices.length
    ) {
      candidateIndices.splice(preferredCandidateIndex, 1);
      candidateIndices.unshift(preferredCandidateIndex);
    }

    for (const idx of candidateIndices) {
      const traceUrl = candidates[idx]!;
      const resp = await fetchFn(traceUrl, {
        method: "GET",
        headers,
        signal: options.signal,
      }).catch(() => null);
      if (!resp || !resp.ok || isHtmlFallbackResponse(resp)) continue;
      const body: unknown = await resp.json().catch(() => undefined);
      if (body !== undefined) {
        if (preferredCandidateIndex === null) {
          preferredCandidateIndex = idx;
        }
        tracesByTraceId[traceId] = body;
        return;
      }
    }
  };

  if (orderedTraceIds.length > 0) {
    await fetchSingleTrace(orderedTraceIds[0]!);
    const remaining = orderedTraceIds.slice(1);
    const concurrency = Math.min(4, remaining.length);
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < remaining.length) {
        const currentIdx = cursor;
        cursor += 1;
        const tid = remaining[currentIdx];
        if (tid !== undefined) {
          await fetchSingleTrace(tid);
        }
      }
    });
    await Promise.all(workers);
  }

  return {
    sessionId: options.sessionId,
    spans,
    tracesByTraceId,
  };
}

export interface GeneratedFileArtifact {
  readonly relativePath: string;
  readonly content: string;
}

export interface CompilePlaywrightOptions {
  readonly targetUrl?: string;
  readonly testFile?: string;
  readonly includeConfig?: boolean;
  readonly sinkEndpoint?: string;
  readonly workspaceId?: string;
  readonly appId?: string;
  readonly store?: "auto" | "blackbox" | "arex";
}

export interface CompiledPlaywrightSuite {
  readonly runner: "playwright";
  readonly sessionId: string;
  readonly actionCount: number;
  readonly outboundAssertionCount: number;
  readonly files: readonly GeneratedFileArtifact[];
}

function sanitizeJsonForAssertion(value: JsonValue | undefined, depth = 0): JsonValue | undefined {
  if (value === undefined || depth > 6) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (value.includes("[REDACTED]")) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    const mapped = value
      .map((item) => sanitizeJsonForAssertion(item, depth + 1))
      .filter((item): item is JsonValue => item !== undefined);
    return mapped.length === value.length ? mapped : undefined;
  }
  const entries: Array<[string, JsonValue]> = [];
  for (const [k, v] of Object.entries(value)) {
    const clean = sanitizeJsonForAssertion(v, depth + 1);
    if (clean !== undefined) {
      entries.push([k, clean]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isMintedTestId(testId: string): boolean {
  return (
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(testId) ||
    testId
      .split(/[-_:./]+/)
      .some((part) => /^(?=(?:\D*\d){2})(?=.*[A-Za-z])[A-Za-z0-9]{10,}$/.test(part))
  );
}

function buildPlaywrightLocatorExpr(
  target: SemanticTarget,
  dynamicName?: CompiledDynamicTextMatch,
  dynamicText?: CompiledDynamicTextMatch,
): string {
  const scopePrefix = target.within
    ? `page.locator("tr, li, article, [role='row'], [role='listitem'], [role='dialog'], [role='region'], fieldset, section").filter({ hasText: ${JSON.stringify(target.within)} }).first()`
    : "page";

  let expr: string;
  let usesTwinPosition = true;
  if (dynamicName && target.role) {
    expr = `${scopePrefix}.getByRole(${JSON.stringify(target.role)}, { name: new RegExp(${JSON.stringify(dynamicName.patternSource)}) })`;
  } else if (target.testId && !isMintedTestId(target.testId)) {
    expr = `${scopePrefix}.getByTestId(${JSON.stringify(target.testId)})`;
  } else if (target.role && target.name) {
    expr = `${scopePrefix}.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true })`;
  } else if (target.label) {
    expr = `${scopePrefix}.getByLabel(${JSON.stringify(target.label)}, { exact: true })`;
    usesTwinPosition = false;
  } else if (target.placeholder) {
    expr = `${scopePrefix}.getByPlaceholder(${JSON.stringify(target.placeholder)}, { exact: true })`;
  } else if (dynamicText) {
    expr = `${scopePrefix}.getByText(new RegExp(${JSON.stringify(dynamicText.patternSource)}))`;
  } else if (target.text) {
    expr = `${scopePrefix}.getByText(${JSON.stringify(target.text)}, { exact: true })`;
  } else if (target.cssSelector) {
    expr = `page.locator(${JSON.stringify(target.cssSelector)})`;
    usesTwinPosition = false;
  } else if (target.role) {
    expr = `${scopePrefix}.getByRole(${JSON.stringify(target.role)})`;
  } else {
    expr = `page.locator("body")`;
    usesTwinPosition = false;
  }

  if (usesTwinPosition && target.position && target.position.of >= 2) {
    return `${expr}.nth(${target.position.index})`;
  }
  return expr;
}

const PLAYWRIGHT_CONTENT_NAMED_ROLES = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

function buildPlaywrightAnchorAssertionExpr(anchor: SemanticTarget): string {
  const text = anchor.name ?? anchor.text;
  if (
    anchor.role &&
    text &&
    !anchor.label &&
    !PLAYWRIGHT_CONTENT_NAMED_ROLES.has(anchor.role)
  ) {
    return `page.getByRole(${JSON.stringify(anchor.role)}).filter({ hasText: ${JSON.stringify(text)} }).first()`;
  }
  return buildPlaywrightLocatorExpr(anchor);
}

function selectVerifiableEndAnchors(anchors: readonly SemanticTarget[]): SemanticTarget[] {
  const priorityRoles = new Set(["alert", "alertdialog", "status", "heading", "dialog"]);
  return anchors
    .filter(
      (anchor) =>
        anchor.role !== undefined &&
        priorityRoles.has(anchor.role) &&
        (anchor.name !== undefined || anchor.text !== undefined),
    )
    .slice(0, 2);
}

function formatOutboundUrlMatcherCode(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `new RegExp(${JSON.stringify(`${escapeRegExpLiteral(parsed.pathname)}$`)})`;
  } catch {
    return JSON.stringify(rawUrl);
  }
}

function formatTriggerPathMatcherCode(matcher: CompiledPathMatcher): string {
  switch (matcher.kind) {
    case "exact":
      return JSON.stringify(matcher.pathname);
    case "regex":
      return `new RegExp(${JSON.stringify(matcher.patternSource)})`;
    default: {
      const _exhaustive: never = matcher;
      return _exhaustive;
    }
  }
}

function triggerPathMatcherKey(method: string, matcher: CompiledPathMatcher): string {
  return matcher.kind === "exact"
    ? `${method}\u0000exact\u0000${matcher.pathname}`
    : `${method}\u0000regex\u0000${matcher.patternSource}`;
}

function formatWaitForResponsePredicateExpr(
  bt: CompiledBackendTrace,
  occurrenceNumber: number,
): string {
  const pathCheck =
    bt.triggerPathMatcher.kind === "exact"
      ? `new URL(res.url()).pathname === ${JSON.stringify(bt.triggerPathMatcher.pathname)}`
      : `new RegExp(${JSON.stringify(bt.triggerPathMatcher.patternSource)}).test(new URL(res.url()).pathname)`;
  const basePredicate = `(res) => res.request().method() === ${JSON.stringify(bt.triggerMethod)} && ${pathCheck}`;
  if (occurrenceNumber <= 1) {
    return basePredicate;
  }
  return `(() => { let seen = 0; return (res) => res.request().method() === ${JSON.stringify(bt.triggerMethod)} && ${pathCheck} && ++seen === ${occurrenceNumber}; })()`;
}

export function compileSessionToPlaywright(
  bundle: CompiledSessionBundle,
  options: CompilePlaywrightOptions = {},
): CompiledPlaywrightSuite {
  const testRelPath = (options.testFile ?? "tests/recorded-session.spec.ts")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const defaultTargetUrl = options.targetUrl ?? bundle.baseOrigin ?? "http://127.0.0.1:3000";
  const initialPath = bundle.steps[0]?.action.startPath || "/";

  const lines: string[] = [
    `import { expect, test } from "@softprobe/e2e/playwright";`,
    ``,
  ];

  if (bundle.secretSlots.length > 0) {
    lines.push(
      `function requireSecret(envName: string, fallbackEnvName?: string): string {`,
      `  const value = process.env[envName] ?? (fallbackEnvName ? process.env[fallbackEnvName] : undefined);`,
      `  if (!value || value.trim() === "") {`,
      `    throw new Error(\`Missing required secret environment variable: \${envName}\`);`,
      `  }`,
      `  return value;`,
      `}`,
      ``,
    );
  }

  lines.push(
    `test.describe("Recorded session replay", () => {`,
    `  test(${JSON.stringify(`replays session ${bundle.sessionId}`)}, async ({ page, trace }) => {`,
  );

  const secretVarBySlot = allocatePlaywrightSecretVars(bundle.secretSlots);
  for (const slot of bundle.secretSlots) {
    const secretIdent = secretVarBySlot.get(slot)!;
    lines.push(
      `    const ${secretIdent} = requireSecret(${JSON.stringify(`SP_SECRET_${slot}`)}, ${JSON.stringify(`E2E_SECRET_${slot}`)});`,
    );
  }

  const firstVerb = bundle.steps[0]?.action.verb;
  if (!(firstVerb?.name === "navigate" && firstVerb.trigger === "load")) {
    lines.push(`    await page.goto(${JSON.stringify(initialPath)});`);
  }

  const extraFixtureFiles: GeneratedFileArtifact[] = [];

  for (let i = 0; i < bundle.steps.length; i += 1) {
    const step = bundle.steps[i]!;
    const verb = step.action.verb;
    const nextStep = bundle.steps[i + 1];

    if (verb.name === "dialog") {
      continue;
    }

    if (nextStep?.action.verb.name === "dialog") {
      const dialogVerb = nextStep.action.verb;
      if (dialogVerb.accepted) {
        const promptArg =
          dialogVerb.promptText?.kind === "literal"
            ? JSON.stringify(dialogVerb.promptText.value)
            : dialogVerb.promptText?.kind === "secret"
              ? (secretVarBySlot.get(dialogVerb.promptText.slot) ??
                `secret_${dialogVerb.promptText.slot.replace(/[^A-Za-z0-9_]/g, "_")}`)
              : "";
        lines.push(`    page.once("dialog", (dialog) => dialog.accept(${promptArg}));`);
      } else {
        lines.push(`    page.once("dialog", (dialog) => dialog.dismiss());`);
      }
    }

    const emitActionLine = (actionStmt: string) => {
      if (step.backendTraces.length === 0) {
        lines.push(`    ${actionStmt}`);
        return;
      }
      if (step.backendTraces.length === 1) {
        const singleTrigger = step.backendTraces[0]!;
        lines.push(
          `    const responsePromise_${i} = page.waitForResponse(${formatWaitForResponsePredicateExpr(singleTrigger, 1)});`,
          `    ${actionStmt}`,
          `    await responsePromise_${i};`,
        );
        return;
      }
      const occurrenceByKey = new Map<string, number>();
      const waitExprs = step.backendTraces.map((bt) => {
        const key = triggerPathMatcherKey(bt.triggerMethod, bt.triggerPathMatcher);
        const occ = (occurrenceByKey.get(key) ?? 0) + 1;
        occurrenceByKey.set(key, occ);
        return `      page.waitForResponse(${formatWaitForResponsePredicateExpr(bt, occ)}),`;
      });
      lines.push(
        `    const responsePromises_${i} = [`,
        ...waitExprs,
        `    ];`,
        `    ${actionStmt}`,
        `    await Promise.all(responsePromises_${i});`,
      );
    };

    switch (verb.name) {
      case "navigate":
        emitActionLine(`await page.goto(${JSON.stringify(verb.url)});`);
        break;
      case "click": {
        const loc = buildPlaywrightLocatorExpr(verb.target, step.dynamicNamePattern, step.dynamicTextPattern);
        const modOpt =
          verb.modifiers && verb.modifiers.length > 0
            ? `{ modifiers: ${JSON.stringify(verb.modifiers)} }`
            : "";
        emitActionLine(`await ${loc}.click(${modOpt});`);
        break;
      }
      case "dblclick": {
        const loc = buildPlaywrightLocatorExpr(verb.target, step.dynamicNamePattern, step.dynamicTextPattern);
        emitActionLine(`await ${loc}.dblclick();`);
        break;
      }
      case "contextmenu": {
        const loc = buildPlaywrightLocatorExpr(verb.target, step.dynamicNamePattern, step.dynamicTextPattern);
        emitActionLine(`await ${loc}.click({ button: "right" });`);
        break;
      }
      case "hover": {
        const loc = buildPlaywrightLocatorExpr(verb.target, step.dynamicNamePattern, step.dynamicTextPattern);
        emitActionLine(`await ${loc}.hover();`);
        break;
      }
      case "fill": {
        const loc = buildPlaywrightLocatorExpr(verb.target);
        if (verb.value.kind === "literal") {
          emitActionLine(`await ${loc}.fill(${JSON.stringify(verb.value.value)});`);
        } else if (verb.value.kind === "secret") {
          const ident =
            secretVarBySlot.get(verb.value.slot) ??
            `secret_${verb.value.slot.replace(/[^A-Za-z0-9_]/g, "_")}`;
          emitActionLine(`await ${loc}.fill(${ident});`);
        } else {
          throw new Error(
            `Cannot compile redacted input at actionIndex=${step.action.actionIndex}; enable inputCapture: "secrets-only" when recording`,
          );
        }
        break;
      }
      case "select": {
        const loc = buildPlaywrightLocatorExpr(verb.target);
        if (verb.value.kind === "literal") {
          emitActionLine(`await ${loc}.selectOption(${JSON.stringify(verb.value.value)});`);
        } else if (verb.value.kind === "secret") {
          const ident =
            secretVarBySlot.get(verb.value.slot) ??
            `secret_${verb.value.slot.replace(/[^A-Za-z0-9_]/g, "_")}`;
          emitActionLine(`await ${loc}.selectOption(${ident});`);
        } else if (verb.optionLabel) {
          emitActionLine(`await ${loc}.selectOption({ label: ${JSON.stringify(verb.optionLabel)} });`);
        } else {
          throw new Error(
            `Cannot compile redacted select at actionIndex=${step.action.actionIndex}; enable inputCapture: "secrets-only" when recording`,
          );
        }
        break;
      }
      case "check": {
        const loc = buildPlaywrightLocatorExpr(verb.target);
        emitActionLine(`await ${loc}.${verb.checked ? "check" : "uncheck"}();`);
        break;
      }
      case "press": {
        const combo =
          verb.modifiers && verb.modifiers.length > 0
            ? `${verb.modifiers.join("+")}+${verb.key}`
            : verb.key;
        if (verb.target) {
          const loc = buildPlaywrightLocatorExpr(verb.target);
          emitActionLine(`await ${loc}.press(${JSON.stringify(combo)});`);
        } else {
          emitActionLine(`await page.keyboard.press(${JSON.stringify(combo)});`);
        }
        break;
      }
      case "upload": {
        const loc = buildPlaywrightLocatorExpr(verb.target);
        const relFiles = verb.fileNames.map((name) => {
          const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_");
          const fixturePath = `fixtures/${safeName}`;
          if (!extraFixtureFiles.some((f) => f.relativePath === fixturePath)) {
            extraFixtureFiles.push({
              relativePath: fixturePath,
              content: "softprobe-upload-fixture\n",
            });
          }
          return fixturePath;
        });
        emitActionLine(`await ${loc}.setInputFiles(${JSON.stringify(relFiles)});`);
        break;
      }
      case "drag": {
        const src = buildPlaywrightLocatorExpr(verb.source);
        const dst = buildPlaywrightLocatorExpr(verb.destination);
        emitActionLine(`await ${src}.dragTo(${dst});`);
        break;
      }
      case "scroll": {
        const dy = verb.direction === "down" ? 400 * verb.times : verb.direction === "up" ? -400 * verb.times : 0;
        const dx = verb.direction === "right" ? 400 * verb.times : verb.direction === "left" ? -400 * verb.times : 0;
        emitActionLine(`await page.mouse.wheel(${dx}, ${dy});`);
        break;
      }
      case "resize":
        emitActionLine(
          `await page.setViewportSize({ width: ${verb.viewport.width}, height: ${verb.viewport.height} });`,
        );
        break;
    }

    for (const anchor of selectVerifiableEndAnchors(step.action.endAnchors)) {
      const anchorLoc = buildPlaywrightAnchorAssertionExpr(anchor);
      lines.push(`    await expect(${anchorLoc}).toBeVisible();`);
    }

    for (let tIdx = 0; tIdx < step.backendTraces.length; tIdx += 1) {
      const bt = step.backendTraces[tIdx]!;
      for (let cIdx = 0; cIdx < bt.outboundCalls.length; cIdx += 1) {
        const call = bt.outboundCalls[cIdx]!;
        const varName = `outbound_${i}_${tIdx}_${cIdx}`;
        lines.push(
          `    const ${varName} = await trace.outboundHttp({`,
          `      triggeredBy: { method: ${JSON.stringify(bt.triggerMethod)}, path: ${formatTriggerPathMatcherCode(bt.triggerPathMatcher)} },`,
          `      method: ${JSON.stringify(call.method)},`,
          `      url: ${formatOutboundUrlMatcherCode(call.url)},`,
          ...(call.status > 0 ? [`      status: ${call.status},`] : []),
          `    });`,
        );
        if (call.status > 0) {
          lines.push(`    expect(${varName}.status).toBe(${call.status});`);
        }
        const expectedJson = sanitizeJsonForAssertion(call.request.json);
        if (expectedJson !== undefined && typeof expectedJson === "object" && expectedJson !== null) {
          lines.push(
            `    expect(${varName}.request.json).toMatchObject(${JSON.stringify(expectedJson)});`,
          );
        }
      }
    }
  }

  lines.push(`  });`, `});`, ``);

  const files: GeneratedFileArtifact[] = [
    ...extraFixtureFiles,
    {
      relativePath: testRelPath,
      content: lines.join("\n"),
    },
  ];

  if (options.includeConfig !== false) {
    const configLines = [
      `import { defineConfig } from "@playwright/test";`,
      `import type { SoftprobePlaywrightFixtures } from "@softprobe/e2e/playwright";`,
      ``,
      `export default defineConfig<SoftprobePlaywrightFixtures>({`,
      `  testDir: "./tests",`,
      `  fullyParallel: false,`,
      `  retries: 0,`,
      `  use: {`,
      `    baseURL: process.env.APP_URL ?? ${JSON.stringify(defaultTargetUrl)},`,
      `    headless: true,`,
      ...(options.sinkEndpoint || options.workspaceId || options.appId || options.store
        ? [
            `    softprobe: {`,
            ...(options.sinkEndpoint
              ? [`      endpoint: process.env.SOFTPROBE_SINK_ENDPOINT ?? ${JSON.stringify(options.sinkEndpoint)},`]
              : []),
            ...(options.workspaceId
              ? [`      workspaceId: process.env.SOFTPROBE_WORKSPACE_ID ?? ${JSON.stringify(options.workspaceId)},`]
              : []),
            ...(options.appId
              ? [`      appId: process.env.SOFTPROBE_APP_ID ?? ${JSON.stringify(options.appId)},`]
              : []),
            ...(options.store
              ? [`      store: ${JSON.stringify(options.store)},`]
              : []),
            `    },`,
          ]
        : []),
      `  },`,
      `});`,
      ``,
    ];
    files.push({
      relativePath: "playwright.config.ts",
      content: configLines.join("\n"),
    });
  }

  return {
    runner: "playwright",
    sessionId: bundle.sessionId,
    actionCount: bundle.steps.length,
    outboundAssertionCount: bundle.outboundAssertionCount,
    files,
  };
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("Non-finite number in canonical JSON");
      }
      return JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
      }
      const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareCodeUnits(a, b));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Unsupported type in canonical JSON: ${typeof value}`);
  }
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function encodeE2ETitle(title: string): string {
  const normalized = title.normalize("NFC");
  const bytes = new TextEncoder().encode(normalized);
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      ch === "-" ||
      ch === "." ||
      ch === "_" ||
      ch === "~"
    ) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export function formatE2ETestId(
  relativeFile: string,
  titlePath: readonly string[],
): string {
  const cleanFile = relativeFile.replace(/\\/g, "/").replace(/^\.\//, "");
  return `${cleanFile}::${titlePath.map(encodeE2ETitle).join("::")}`;
}

export function normalizeE2EInstruction(instruction: string): string {
  return instruction.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
}

export interface E2ECacheKeyInput {
  readonly projectId: string;
  readonly testId: string;
  readonly targetId: string;
  readonly appIdentity: string;
  readonly appEnvironment: "test" | "staging" | "production";
  readonly instruction: string;
  readonly secretSlots?: readonly string[];
  readonly callIndex: number;
  readonly agentName?: string;
  readonly agentContext?: string;
}

export interface E2ECacheKeyResult {
  readonly keyHash: string;
  readonly instructionDigest: string;
  readonly paramsDigest: string;
  readonly projectedParams: Readonly<Record<string, unknown>>;
  readonly keyedBy: {
    readonly cacheSchema: "trace-1";
    readonly policyVersion: "conservative/6";
    readonly project: string;
    readonly platform: "web";
    readonly engineName: "web";
    readonly engineSpiVersion: 1;
    readonly appIdentity: string;
    readonly agentContextDigest: string;
  };
}

// Match @e2e-dev/core 0.24.0 trace-1 cache key projection across appIdentity, testId, conservative/6 policy, and secret descriptors.
export function buildE2ECacheKeyAndHash(input: E2ECacheKeyInput): E2ECacheKeyResult {
  const projectedParams: Record<string, unknown> = {};
  const paramKeyBySlot = allocateE2ESecretParamKeys(input.secretSlots ?? []);
  for (const slot of [...new Set(input.secretSlots ?? [])].sort(compareCodeUnits)) {
    const paramKey = paramKeyBySlot.get(slot)!;
    projectedParams[paramKey] = {
      kind: "secret",
      name: slot,
      purpose: "generic-secret",
    };
  }
  const instrDigest = sha256Hex(normalizeE2EInstruction(input.instruction));
  const pDigest = canonicalDigest(projectedParams);
  const projectHash = sha256Hex(input.projectId);
  const appIdentityHash = canonicalDigest({
    identity: input.appIdentity,
    environment: input.appEnvironment,
  });
  const agentName = input.agentName ?? "default";
  const agentContextDigest = sha256Hex(input.agentContext ?? "");

  const fullKey = {
    specVersion: "0.1",
    cacheSchema: E2E_TRACE_SCHEMA_VERSION,
    project: projectHash,
    testId: input.testId,
    targetId: input.targetId,
    platform: "web" as const,
    engineName: "web" as const,
    engineSpiVersion: E2E_ENGINE_SPI_VERSION,
    kind: "act" as const,
    callIndex: input.callIndex,
    instructionDigest: instrDigest,
    paramsDigest: pDigest,
    appIdentity: appIdentityHash,
    agent: agentName,
    agentContextDigest,
    policyVersion: E2E_REPLAY_POLICY_VERSION,
  };

  return {
    keyHash: canonicalDigest(fullKey),
    instructionDigest: instrDigest,
    paramsDigest: pDigest,
    projectedParams,
    keyedBy: {
      cacheSchema: E2E_TRACE_SCHEMA_VERSION,
      policyVersion: E2E_REPLAY_POLICY_VERSION,
      project: projectHash,
      platform: "web",
      engineName: "web",
      engineSpiVersion: E2E_ENGINE_SPI_VERSION,
      appIdentity: appIdentityHash,
      agentContextDigest,
    },
  };
}

export interface E2ETraceTargetDescriptor {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly placeholder?: string;
  readonly selector?: string;
  readonly inputPurpose?: string;
  readonly within?: string;
  readonly value?: string;
  readonly position?: { readonly index: number; readonly of: number };
  readonly states?: readonly SemanticAnchorState[];
}

const VALID_E2E_INPUT_PURPOSES = new Set(["password", "username", "one-time-code"]);
const CONTENT_NAMED_ANCHOR_ROLES = new Set([
  "alert",
  "alertdialog",
  "status",
  "button",
  "link",
  "heading",
  "option",
  "tab",
  "menuitem",
  "checkbox",
  "radio",
  "switch",
]);

function boundStr(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function toE2ETargetDescriptor(target: SemanticTarget): E2ETraceTargetDescriptor {
  const role = boundStr(target.role, 300);
  const name = boundStr(target.name, 300);
  const rawText = boundStr(target.text, 300);
  const text =
    rawText !== undefined &&
    rawText !== name &&
    !(role !== undefined && CONTENT_NAMED_ANCHOR_ROLES.has(role) && name !== undefined)
      ? rawText
      : undefined;
  const testId = boundStr(target.testId, 300);
  const placeholder = boundStr(target.placeholder, 300);
  const selector = boundStr(target.cssSelector, 300);
  const inputPurpose =
    target.inputPurpose && VALID_E2E_INPUT_PURPOSES.has(target.inputPurpose)
      ? target.inputPurpose
      : undefined;
  const within = boundStr(target.within, 80);

  const hasIdentity =
    testId !== undefined ||
    name !== undefined ||
    text !== undefined ||
    placeholder !== undefined;

  const position =
    target.position &&
    target.position.of >= (hasIdentity ? 2 : 1) &&
    target.position.of <= 1000 &&
    target.position.index >= 0 &&
    target.position.index < target.position.of
      ? { index: target.position.index, of: target.position.of }
      : !hasIdentity && role !== undefined
        ? { index: 0, of: 1 }
        : undefined;

  const out: E2ETraceTargetDescriptor = {
    ...(role !== undefined ? { role } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(testId !== undefined ? { testId } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(selector !== undefined ? { selector } : {}),
    ...(inputPurpose !== undefined ? { inputPurpose } : {}),
    ...(within !== undefined ? { within } : {}),
    ...(position !== undefined ? { position } : {}),
  };

  if (Object.keys(out).length === 0) {
    return { role: "button", position: { index: 0, of: 1 } };
  }
  return out;
}

function toE2EAnchorDescriptor(target: SemanticTarget): E2ETraceTargetDescriptor | undefined {
  const role = boundStr(target.role, 300);
  const name = boundStr(target.name, 300);
  const rawText = boundStr(target.text, 300);
  const text =
    rawText !== undefined &&
    rawText !== name &&
    !(role !== undefined && CONTENT_NAMED_ANCHOR_ROLES.has(role) && name !== undefined)
      ? rawText
      : undefined;
  const testId = boundStr(target.testId, 300);
  const placeholder = boundStr(target.placeholder, 300);
  const inputPurpose =
    target.inputPurpose && VALID_E2E_INPUT_PURPOSES.has(target.inputPurpose)
      ? target.inputPurpose
      : undefined;
  const value =
    inputPurpose === "password" || role === "checkbox" || role === "radio"
      ? undefined
      : boundStr(target.value, 300);
  const states =
    target.states && target.states.length > 0
      ? [...new Set(target.states)].sort()
      : undefined;

  if (
    testId === undefined &&
    name === undefined &&
    text === undefined &&
    placeholder === undefined
  ) {
    return undefined;
  }

  return {
    ...(role !== undefined ? { role } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(testId !== undefined ? { testId } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(inputPurpose !== undefined ? { inputPurpose } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(states !== undefined ? { states } : {}),
  };
}

function e2eAnchorKey(desc: E2ETraceTargetDescriptor): string {
  return JSON.stringify([
    desc.role ?? null,
    desc.name ?? null,
    desc.text ?? null,
    desc.testId ?? null,
    desc.placeholder ?? null,
    desc.inputPurpose ?? null,
    desc.value ?? null,
    desc.states ? desc.states.join(",") : "",
  ]);
}

function isE2EAnchorRelocatable(desc: E2ETraceTargetDescriptor): boolean {
  return (
    desc.testId !== undefined ||
    desc.name !== undefined ||
    desc.text !== undefined ||
    desc.placeholder !== undefined
  );
}

interface E2ERecordedActionEntry {
  readonly name: string;
  readonly summary: string;
  readonly [key: string]: unknown;
}

function convertSemanticStepToE2ERecordedAction(
  step: CompiledSessionStep,
  extraFixtureFiles: GeneratedFileArtifact[],
): E2ERecordedActionEntry | null {
  const verb = step.action.verb;
  const summary = (step.summary || verb.name).slice(0, 300);

  switch (verb.name) {
    case "dialog":
      return null;
    case "navigate":
      return {
        name: "navigate",
        summary,
        url: verb.url,
      };
    case "click": {
      const target = toE2ETargetDescriptor(verb.target);
      const hasIdentity =
        target.testId !== undefined ||
        target.name !== undefined ||
        target.text !== undefined ||
        target.placeholder !== undefined;
      if (!hasIdentity && verb.point) {
        return {
          name: "tapAt",
          summary,
          point: { x: verb.point.x, y: verb.point.y },
          viewport: {
            width: step.action.viewport.width,
            height: step.action.viewport.height,
          },
        };
      }
      return {
        name: "tap",
        summary,
        target,
        ...(verb.modifiers && verb.modifiers.length > 0 ? { modifiers: [...verb.modifiers] } : {}),
      };
    }
    case "dblclick":
      return {
        name: "doubleTap",
        summary,
        target: toE2ETargetDescriptor(verb.target),
        ...(verb.modifiers && verb.modifiers.length > 0 ? { modifiers: [...verb.modifiers] } : {}),
      };
    case "contextmenu":
      return {
        name: "secondaryTap",
        summary,
        target: toE2ETargetDescriptor(verb.target),
        ...(verb.modifiers && verb.modifiers.length > 0 ? { modifiers: [...verb.modifiers] } : {}),
      };
    case "hover":
      return {
        name: "hover",
        summary,
        target: toE2ETargetDescriptor(verb.target),
      };
    case "fill": {
      const target = toE2ETargetDescriptor(verb.target);
      if (verb.value.kind === "secret") {
        return {
          name: "typeSecret",
          summary,
          target,
          secret: verb.value.slot,
        };
      }
      if (verb.value.kind === "literal") {
        return {
          name: "type",
          summary,
          target,
          value: verb.value.value,
        };
      }
      throw new Error(
        `Cannot compile redacted input at actionIndex=${step.action.actionIndex}; record with inputCapture: "secrets-only"`,
      );
    }
    case "select": {
      const target = toE2ETargetDescriptor(verb.target);
      const val =
        verb.optionLabel ??
        (verb.value.kind === "literal" ? verb.value.value : undefined);
      if (!val) {
        throw new Error(
          `Cannot compile non-literal select at actionIndex=${step.action.actionIndex}`,
        );
      }
      return {
        name: "select",
        summary,
        target,
        value: val,
      };
    }
    case "check":
      return {
        name: "check",
        summary,
        target: toE2ETargetDescriptor(verb.target),
        checked: verb.checked,
      };
    case "press": {
      const combo =
        verb.modifiers && verb.modifiers.length > 0
          ? `${verb.modifiers.join("+")}+${verb.key}`
          : verb.key;
      if (verb.target) {
        return {
          name: "press",
          summary,
          target: toE2ETargetDescriptor(verb.target),
          key: combo,
        };
      }
      return {
        name: "pressKey",
        summary,
        key: combo,
      };
    }
    case "upload": {
      const paths = verb.fileNames.map((name) => {
        const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_");
        const fixturePath = `fixtures/${safeName}`;
        if (!extraFixtureFiles.some((f) => f.relativePath === fixturePath)) {
          extraFixtureFiles.push({
            relativePath: fixturePath,
            content: "softprobe-upload-fixture\n",
          });
        }
        return fixturePath;
      });
      return {
        name: "upload",
        summary,
        target: toE2ETargetDescriptor(verb.target),
        paths,
      };
    }
    case "drag":
      return {
        name: "drag",
        summary,
        target: toE2ETargetDescriptor(verb.source),
        destination: toE2ETargetDescriptor(verb.destination),
      };
    case "scroll":
      return {
        name: "scroll",
        summary,
        direction: verb.direction,
        ...(verb.target ? { target: toE2ETargetDescriptor(verb.target) } : {}),
        ...(verb.times >= 2 ? { times: verb.times } : {}),
        ...(verb.spansViewport >= 0 && verb.spansViewport <= 1
          ? { spans: verb.spansViewport }
          : {}),
      };
    case "resize":
      return {
        name: "resize",
        summary,
        size: {
          width: Math.min(7680, Math.max(200, verb.viewport.width)),
          height: Math.min(4320, Math.max(200, verb.viewport.height)),
        },
      };
    default: {
      const _exhaustive: never = verb;
      return _exhaustive;
    }
  }
}

function isPreparatoryStep(step: CompiledSessionStep): boolean {
  if (step.backendTraces.length > 0) return false;
  if (step.action.startPath !== step.action.endPath) return false;
  switch (step.action.verb.name) {
    case "fill":
    case "select":
    case "check":
    case "upload":
    case "hover":
    case "scroll":
    case "resize":
      return true;
    case "press":
      return step.action.verb.key !== "Enter";
    default:
      return false;
  }
}

interface LogicalE2EStepGroup {
  readonly steps: readonly CompiledSessionStep[];
  readonly startPath: string;
  readonly endPath: string;
  readonly instruction: string;
  readonly secretSlots: readonly string[];
  readonly dialogActions: ReadonlyArray<Extract<SemanticVerb, { readonly name: "dialog" }>>;
  readonly backendTraces: readonly CompiledBackendTrace[];
  readonly endAnchors: readonly E2ETraceTargetDescriptor[];
  readonly goneAnchors: readonly E2ETraceTargetDescriptor[];
  readonly rawEndTargets: readonly SemanticTarget[];
  readonly settleMs: number;
}

function foldGroupAnchors(steps: readonly CompiledSessionStep[]): {
  readonly endAnchors: readonly E2ETraceTargetDescriptor[];
  readonly goneAnchors: readonly E2ETraceTargetDescriptor[];
} {
  const appeared = new Map<string, E2ETraceTargetDescriptor>();
  const vanished = new Map<string, E2ETraceTargetDescriptor>();

  for (const step of steps) {
    for (const rawGone of step.action.goneAnchors) {
      const desc = toE2EAnchorDescriptor(rawGone);
      if (!desc || !isE2EAnchorRelocatable(desc)) continue;
      const key = e2eAnchorKey(desc);
      if (appeared.has(key)) {
        appeared.delete(key);
      } else if (!vanished.has(key)) {
        vanished.set(key, desc);
      }
    }
    for (const rawEnd of step.action.endAnchors) {
      const desc = toE2EAnchorDescriptor(rawEnd);
      if (!desc || !isE2EAnchorRelocatable(desc)) continue;
      const key = e2eAnchorKey(desc);
      if (vanished.has(key)) {
        vanished.delete(key);
      } else {
        appeared.set(key, desc);
      }
    }
  }

  const orderAnchors = (items: Iterable<E2ETraceTargetDescriptor>): E2ETraceTargetDescriptor[] => {
    const announcements: E2ETraceTargetDescriptor[] = [];
    const rest: E2ETraceTargetDescriptor[] = [];
    for (const item of items) {
      if (
        item.role === "alert" ||
        item.role === "alertdialog" ||
        item.role === "status"
      ) {
        announcements.push(item);
      } else {
        rest.push(item);
      }
    }
    return [...announcements, ...rest].slice(0, 8);
  };

  return {
    endAnchors: orderAnchors(appeared.values()),
    goneAnchors: orderAnchors(vanished.values()),
  };
}

function groupStepsForE2E(steps: readonly CompiledSessionStep[]): LogicalE2EStepGroup[] {
  const nonLoadSteps = steps.filter(
    (s, idx) => !(idx === 0 && s.action.verb.name === "navigate" && s.action.verb.trigger === "load"),
  );
  if (nonLoadSteps.length === 0) return [];

  const rawGroups: CompiledSessionStep[][] = [];
  let buffer: CompiledSessionStep[] = [];

  for (let i = 0; i < nonLoadSteps.length; i += 1) {
    const step = nonLoadSteps[i]!;
    if (step.action.verb.name === "dialog") {
      if (buffer.length > 0) {
        buffer.push(step);
      } else if (rawGroups.length > 0) {
        rawGroups[rawGroups.length - 1]!.push(step);
      }
      continue;
    }

    buffer.push(step);
    const nextNonDialog = nonLoadSteps
      .slice(i + 1)
      .find((cand) => cand.action.verb.name !== "dialog");

    if (!isPreparatoryStep(step) || !nextNonDialog) {
      while (i + 1 < nonLoadSteps.length && nonLoadSteps[i + 1]?.action.verb.name === "dialog") {
        i += 1;
        buffer.push(nonLoadSteps[i]!);
      }
      rawGroups.push(buffer);
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    rawGroups.push(buffer);
  }

  return rawGroups.map((groupSteps, gIdx) => {
    const first = groupSteps[0]!;
    const last = groupSteps[groupSteps.length - 1]!;
    const slots = new Set<string>();
    const dialogs: Array<Extract<SemanticVerb, { readonly name: "dialog" }>> = [];
    const backendTraces: CompiledBackendTrace[] = [];

    for (const s of groupSteps) {
      collectActionSecretSlots(s.action.verb, slots);
      if (s.action.verb.name === "dialog") {
        dialogs.push(s.action.verb);
      }
      backendTraces.push(...s.backendTraces);
    }

    const actionProseList = groupSteps
      .filter((s) => s.action.verb.name !== "dialog")
      .map((s) => s.summary);
    const joinedProse = actionProseList.join(", then ");
    const instruction =
      joinedProse.length <= 240
        ? `Step ${gIdx + 1}: ${joinedProse}`
        : `Step ${gIdx + 1}: ${joinedProse.slice(0, 237)}...`;

    const { endAnchors, goneAnchors } = foldGroupAnchors(groupSteps);
    const totalSettleMs = groupSteps.reduce((sum, s) => sum + s.action.settleMs, 0);

    return {
      steps: groupSteps,
      startPath: first.action.startPath || "/",
      endPath: last.action.endPath || first.action.startPath || "/",
      instruction,
      secretSlots: [...slots].sort(),
      dialogActions: dialogs,
      backendTraces,
      endAnchors,
      goneAnchors,
      rawEndTargets: last.action.endAnchors,
      settleMs: totalSettleMs,
    };
  });
}

export interface CompileE2EOptions {
  readonly projectId?: string;
  readonly targetName?: string;
  readonly targetUrl?: string;
  readonly appIdentity?: string;
  readonly appEnvironment?: "test" | "staging" | "production";
  readonly testFile?: string;
  readonly includeConfig?: boolean;
  readonly sinkEndpoint?: string;
  readonly workspaceId?: string;
  readonly appId?: string;
  readonly store?: "auto" | "blackbox" | "arex";
  readonly createdAt?: string;
}

export interface CompiledE2ESuite {
  readonly runner: "e2e";
  readonly sessionId: string;
  readonly projectId: string;
  readonly targetName: string;
  readonly appIdentity: string;
  readonly testId: string;
  readonly actionCount: number;
  readonly outboundAssertionCount: number;
  readonly files: readonly GeneratedFileArtifact[];
  readonly cacheFiles: readonly GeneratedFileArtifact[];
}

function buildE2EScreenAssertionLine(group: LogicalE2EStepGroup): string {
  const candidates = selectVerifiableEndAnchors(group.rawEndTargets);
  const best = candidates[0];
  if (best && best.role && (best.name || best.text)) {
    const label = best.name ?? best.text!;
    if (!best.label && !PLAYWRIGHT_CONTENT_NAMED_ROLES.has(best.role)) {
      return `    await expect(screen.getByRole(${JSON.stringify(best.role)})).toContainText(${JSON.stringify(label)});`;
    }
    return `    await expect(screen.getByRole(${JSON.stringify(best.role)}, ${JSON.stringify(label)})).toBeVisible();`;
  }
  const firstEnd = group.endAnchors[0];
  if (firstEnd?.role && firstEnd.name) {
    if (!PLAYWRIGHT_CONTENT_NAMED_ROLES.has(firstEnd.role)) {
      return `    await expect(screen.getByRole(${JSON.stringify(firstEnd.role)})).toContainText(${JSON.stringify(firstEnd.name)});`;
    }
    return `    await expect(screen.getByRole(${JSON.stringify(firstEnd.role)}, ${JSON.stringify(firstEnd.name)})).toBeVisible();`;
  }
  return `    await expect(app).toHaveURL(new RegExp(${JSON.stringify(escapeRegExpLiteral(group.endPath.split("?")[0] ?? "/"))}));`;
}

export function compileSessionToE2E(
  bundle: CompiledSessionBundle,
  options: CompileE2EOptions = {},
): CompiledE2ESuite {
  const projectId = options.projectId?.trim() || "softprobe-compiled-e2e";
  const targetName = options.targetName?.trim() || "web";
  const defaultTargetUrl = options.targetUrl ?? bundle.baseOrigin ?? "http://127.0.0.1:3000";
  const appIdentity = options.appIdentity?.trim() || "softprobe-recorded-app";
  const appEnvironment = options.appEnvironment ?? "test";
  const testRelPath = (options.testFile ?? "tests/recorded-session.e2e.ts")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const createdAt = options.createdAt ?? new Date().toISOString();

  const suiteTitle = "Recorded session replay";
  const testTitle = `replays session ${bundle.sessionId}`;
  const fullTestId = formatE2ETestId(testRelPath, [suiteTitle, testTitle]);

  const groups = groupStepsForE2E(bundle.steps);
  const initialStartPath =
    groups[0]?.startPath ?? bundle.steps[0]?.action.startPath ?? "/";

  const extraFixtureFiles: GeneratedFileArtifact[] = [];
  const cacheFiles: GeneratedFileArtifact[] = [];
  const callCounts = new Map<string, number>();

  const needsSecretsImport = bundle.secretSlots.length > 0;
  const needsBrowserFixture = groups.some((g) => g.dialogActions.length > 0);

  const testLines: string[] = [
    `import {`,
    `  describe,`,
    `  expect,`,
    ...(needsSecretsImport ? [`  secrets,`] : []),
    `  test,`,
    `} from "@softprobe/e2e";`,
    ``,
    `describe(${JSON.stringify(suiteTitle)}, () => {`,
    `  test(${JSON.stringify(testTitle)}, async ({ app, agent, screen, trace${needsBrowserFixture ? ", browser" : ""} }) => {`,
    `    await app.open(${JSON.stringify(initialStartPath)});`,
  ];

  for (let gIdx = 0; gIdx < groups.length; gIdx += 1) {
    const group = groups[gIdx]!;
    const recordedActions = group.steps
      .map((s) => convertSemanticStepToE2ERecordedAction(s, extraFixtureFiles))
      .filter((item): item is E2ERecordedActionEntry => item !== null);

    if (recordedActions.length === 0) continue;

    const sigProbeKey = `${group.instruction}\u0000${group.secretSlots.join(",")}`;
    const callIndex = callCounts.get(sigProbeKey) ?? 0;
    callCounts.set(sigProbeKey, callIndex + 1);

    const keyInfo = buildE2ECacheKeyAndHash({
      projectId,
      testId: fullTestId,
      targetId: targetName,
      appIdentity,
      appEnvironment,
      instruction: group.instruction,
      secretSlots: group.secretSlots,
      callIndex,
    });

    const endWaitMs = Math.min(120_000, Math.max(10_000, Math.round(group.settleMs + 10_000)));
    const traceEntryDoc = {
      schemaVersion: E2E_TRACE_SCHEMA_VERSION,
      createdAt,
      payload: {
        actions: recordedActions,
        executor: {
          name: "softprobe-session-compiler",
          version: "0.1.0",
        },
        recordedFor: {
          testId: fullTestId,
          targetId: targetName,
          instructionDigest: keyInfo.instructionDigest,
          paramsDigest: keyInfo.paramsDigest,
          callIndex,
          agent: "default",
        },
        summary: group.instruction.slice(0, 300),
        startPath: group.startPath,
        endPath: group.endPath,
        ...(group.endAnchors.length > 0 ? { endAnchors: group.endAnchors } : {}),
        ...(group.goneAnchors.length > 0 ? { goneAnchors: group.goneAnchors } : {}),
        endWaitMs,
        keyedBy: keyInfo.keyedBy,
      },
    };

    cacheFiles.push({
      relativePath: `.e2e/cache/${keyInfo.keyHash}.json`,
      content: `${JSON.stringify(traceEntryDoc, null, 2)}\n`,
    });

    for (const dialogAction of group.dialogActions) {
      if (dialogAction.accepted) {
        const promptArg =
          dialogAction.promptText?.kind === "literal"
            ? JSON.stringify(dialogAction.promptText.value)
            : dialogAction.promptText?.kind === "secret"
              ? `secrets.get(${JSON.stringify(dialogAction.promptText.slot)})`
              : "";
        testLines.push(
          `    browser.onDialog((dialog) => dialog.accept(${promptArg}));`,
        );
      } else {
        testLines.push(`    browser.onDialog((dialog) => dialog.dismiss());`);
      }
    }

    if (group.secretSlots.length > 0) {
      const paramKeyBySlot = allocateE2ESecretParamKeys(group.secretSlots);
      const paramEntries = group.secretSlots.map((slot) => {
        const paramKey = paramKeyBySlot.get(slot)!;
        return `${JSON.stringify(paramKey)}: secrets.get(${JSON.stringify(slot)})`;
      });
      testLines.push(
        `    await agent.act(${JSON.stringify(group.instruction)}, {`,
        `      params: { ${paramEntries.join(", ")} },`,
        `    });`,
      );
    } else {
      testLines.push(`    await agent.act(${JSON.stringify(group.instruction)});`);
    }

    testLines.push(buildE2EScreenAssertionLine(group));

    for (let tIdx = 0; tIdx < group.backendTraces.length; tIdx += 1) {
      const bt = group.backendTraces[tIdx]!;
      for (let cIdx = 0; cIdx < bt.outboundCalls.length; cIdx += 1) {
        const call = bt.outboundCalls[cIdx]!;
        const varName = `outbound_${gIdx}_${tIdx}_${cIdx}`;
        testLines.push(
          `    const ${varName} = await trace.outboundHttp({`,
          `      triggeredBy: { method: ${JSON.stringify(bt.triggerMethod)}, path: ${formatTriggerPathMatcherCode(bt.triggerPathMatcher)} },`,
          `      method: ${JSON.stringify(call.method)},`,
          `      url: ${formatOutboundUrlMatcherCode(call.url)},`,
          ...(call.status > 0 ? [`      status: ${call.status},`] : []),
          `    });`,
        );
        if (call.status > 0) {
          testLines.push(`    expect(${varName}.status).toBe(${call.status});`);
        }
        const expectedJson = sanitizeJsonForAssertion(call.request.json);
        if (expectedJson !== undefined && typeof expectedJson === "object" && expectedJson !== null) {
          testLines.push(
            `    expect(${varName}.request.json).toMatchObject(${JSON.stringify(expectedJson)});`,
          );
        }
      }
    }
  }

  testLines.push(
    `  });`,
    `});`,
    ``,
  );

  const files: GeneratedFileArtifact[] = [
    ...extraFixtureFiles,
    {
      relativePath: testRelPath,
      content: testLines.join("\n"),
    },
  ];

  if (options.includeConfig !== false) {
    const configLines: string[] = [
      `import type { E2EConfig } from "e2e";`,
      `import { softprobeCachedAgent, softprobeReporter, softprobeWeb } from "@softprobe/e2e";`,
      ``,
    ];

    if (bundle.secretSlots.length > 0) {
      configLines.push(
        `function requireSecretEnv(primaryEnv: string, fallbackEnv: string): string {`,
        `  const value = process.env[primaryEnv] ?? process.env[fallbackEnv];`,
        `  if (!value || value.trim() === "") {`,
        `    throw new Error(\`Missing required secret environment variable: \${primaryEnv}\`);`,
        `  }`,
        `  return value;`,
        `}`,
        ``,
      );
    }

    configLines.push(
      `export default {`,
      `  projectId: ${JSON.stringify(projectId)},`,
      `  workers: 1,`,
      `  retries: 0,`,
      `  tests: "tests/**/*.e2e.ts",`,
      `  cache: {`,
      `    dir: ".e2e/cache",`,
      `    mode: "read-write",`,
      `  },`,
      `  agents: {`,
      `    default: softprobeCachedAgent(),`,
      `  },`,
      ...(bundle.secretSlots.length > 0
        ? [
            `  secrets: {`,
            ...bundle.secretSlots.map(
              (slot) =>
                `    ${JSON.stringify(slot)}: () => requireSecretEnv(${JSON.stringify(`SP_SECRET_${slot}`)}, ${JSON.stringify(`E2E_SECRET_${slot}`)}),`,
            ),
            `  },`,
          ]
        : []),
      `  targets: [`,
      `    {`,
      `      name: ${JSON.stringify(targetName)},`,
      `      engine: softprobeWeb({`,
      ...(options.sinkEndpoint
        ? [`        endpoint: process.env.SOFTPROBE_SINK_ENDPOINT ?? ${JSON.stringify(options.sinkEndpoint)},`]
        : []),
      ...(options.workspaceId
        ? [`        workspaceId: process.env.SOFTPROBE_WORKSPACE_ID ?? ${JSON.stringify(options.workspaceId)},`]
        : []),
      ...(options.appId
        ? [`        appId: process.env.SOFTPROBE_APP_ID ?? ${JSON.stringify(options.appId)},`]
        : []),
      ...(options.store
        ? [`        store: ${JSON.stringify(options.store)},`]
        : []),
      `      }),`,
      `      app: {`,
      `        url: process.env.APP_URL ?? ${JSON.stringify(defaultTargetUrl)},`,
      `        identity: ${JSON.stringify(appIdentity)},`,
      `        environment: ${JSON.stringify(appEnvironment)},`,
      `      },`,
      `    },`,
      `  ],`,
      `  reporters: [softprobeReporter()],`,
      `} satisfies E2EConfig;`,
      ``,
    );

    files.push({
      relativePath: "e2e.config.ts",
      content: configLines.join("\n"),
    });
  }

  return {
    runner: "e2e",
    sessionId: bundle.sessionId,
    projectId,
    targetName,
    appIdentity,
    testId: fullTestId,
    actionCount: bundle.steps.length,
    outboundAssertionCount: bundle.outboundAssertionCount,
    files,
    cacheFiles,
  };
}

export interface SoftprobeCachedAgentOptions {
  readonly model?: ModelInstance;
  readonly judge?: ModelInstance;
  readonly context?: string;
}

// Satisfy e2e WorkerModels.preflight on zero-LLM cached replay while forwarding live models when recording new agent.act steps.
export function softprobeCachedAgent(
  options: SoftprobeCachedAgentOptions = {},
): AgentConfig {
  if (options.model !== undefined) {
    return {
      model: options.model,
      ...(options.judge !== undefined ? { judge: options.judge } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
    };
  }
  return {
    ...(options.context !== undefined ? { context: options.context } : {}),
    executor: {
      name: "softprobe-session-replay",
      version: "0.1.0",
      async runStep(context) {
        throw new AgentError(
          "MODEL_UNAVAILABLE",
          `No cached ActionTrace completed step ${JSON.stringify(context.step.instruction)} and no LLM model was passed to softprobeCachedAgent({ model }). Configure a model in e2e.config.ts to record new agent.act() steps.`,
        );
      },
    },
  };
}
