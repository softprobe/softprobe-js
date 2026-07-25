import type { Attributes as OtelAttributes } from "@opentelemetry/api";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";
import type {
  Attributes,
  NormalizedSpan,
  NormalizedSpanEvent,
  ObservationType,
} from "./types.js";

export function normalizeReadableSpans(
  spans: ReadableSpan[],
): NormalizedSpan[] {
  const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  const normalized = spans.map((span) => normalizeOne(span, byId));
  return normalized.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeOne(
  span: ReadableSpan,
  byId: Map<string, ReadableSpan>,
): NormalizedSpan {
  const attributes = normalizeAttributes(span.attributes);
  const observationType = (attributes["sp.observation.type"] ??
    "span") as ObservationType;
  const parentId = span.parentSpanId;
  const parent = parentId ? byId.get(parentId) : undefined;
  return {
    name: span.name,
    observation_type: observationType,
    parent_name: parent?.name ?? null,
    attributes,
    events: span.events.map(normalizeEvent),
    status_code:
      span.status.code === 0 ? "UNSET" : span.status.code === 1 ? "OK" : "ERROR",
    status_message: span.status.message ?? null,
  };
}

function normalizeEvent(event: TimedEvent): NormalizedSpanEvent {
  const attributes: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      attributes[key] = JSON.stringify(value);
    } else {
      attributes[key] = value as string | number | boolean;
    }
  }
  return { name: event.name, attributes };
}

function normalizeAttributes(raw: OtelAttributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key] = value as Attributes[string];
  }
  return out;
}

export function pickContractFields(span: NormalizedSpan): NormalizedSpan {
  return {
    name: span.name,
    observation_type: span.observation_type,
    parent_name: span.parent_name,
    attributes: span.attributes,
    events: span.events,
    status_code: span.status_code,
    status_message: span.status_message,
  };
}
