import type { RrwebEventBatchItem } from "./types.js";

const SPAN_NAME = "softprobe.web.recording";
const EVENT_NAME = "sp.recording.batch";
const EVENTS_ATTR = "sp.recording.events";

export type OtlpStringAttr = {
  key: string;
  value: { stringValue: string };
};

export type OtlpIntAttr = {
  key: string;
  value: { intValue: string };
};

export type OtlpAttr = OtlpStringAttr | OtlpIntAttr;

export type BuildRecordingSpanInput = {
  traceId: string;
  spanId: string;
  sessionId: string;
  batchIndex: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  events: RrwebEventBatchItem[];
  attributes: Record<string, string | number | boolean | null | undefined>;
  serviceName?: string;
  environment?: string;
};

function stringAttr(key: string, value: string): OtlpStringAttr {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpIntAttr {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function toAttrs(
  attributes: Record<string, string | number | boolean | null | undefined>,
): OtlpAttr[] {
  const out: OtlpAttr[] = [];
  for (const [key, raw] of Object.entries(attributes)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out.push(intAttr(key, raw));
      continue;
    }
    out.push(stringAttr(key, String(raw)));
  }
  return out;
}

/** Build an OTLP JSON ExportTraceServiceRequest for one recording flush. */
export function buildRecordingExport(input: BuildRecordingSpanInput): {
  resourceSpans: unknown[];
} {
  const attrs: OtlpAttr[] = [
    stringAttr("sp.session.id", input.sessionId),
    stringAttr("sp.observation.type", "recording"),
    intAttr("sp.recording.batch_index", input.batchIndex),
    ...toAttrs(input.attributes),
  ];

  const resourceAttrs: OtlpAttr[] = [];
  if (input.serviceName) {
    resourceAttrs.push(stringAttr("service.name", input.serviceName));
  }
  if (input.environment) {
    resourceAttrs.push(
      stringAttr("deployment.environment.name", input.environment),
    );
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: "softprobe.web.record", version: "0.1.0" },
            spans: [
              {
                traceId: input.traceId,
                spanId: input.spanId,
                name: SPAN_NAME,
                kind: 1,
                startTimeUnixNano: input.startTimeUnixNano,
                endTimeUnixNano: input.endTimeUnixNano,
                attributes: attrs,
                events: [
                  {
                    timeUnixNano: input.endTimeUnixNano,
                    name: EVENT_NAME,
                    attributes: [
                      stringAttr(EVENTS_ATTR, JSON.stringify(input.events)),
                    ],
                  },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function randomHexId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function msToUnixNano(ms: number): string {
  return `${BigInt(Math.trunc(ms)) * 1_000_000n}`;
}

export { SPAN_NAME, EVENT_NAME, EVENTS_ATTR };
