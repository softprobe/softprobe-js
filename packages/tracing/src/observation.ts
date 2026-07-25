import {
  SpanStatusCode,
  type Span,
  type Tracer,
  context,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import {
  buildGenerationAttributes,
  buildObservationAttributes,
} from "./attributes.js";
import { getPropagatedAttributes } from "./propagation.js";
import { serializeCaptured } from "./redaction.js";
import type {
  Attributes,
  JsonValue,
  ObservationType,
  StartGenerationOptions,
  StartObservationOptions,
  UpdateGenerationOptions,
  UpdateObservationOptions,
} from "./types.js";

export interface ObservationRuntime {
  tracer: Tracer;
  redactKeys: string[];
  sessionId?: string;
  userId?: string;
  release?: string;
  tags?: string[];
}

function mergeDefaults(
  runtime: ObservationRuntime,
  options: StartObservationOptions | StartGenerationOptions,
) {
  const propagated = getPropagatedAttributes();
  return {
    sessionId: options.sessionId ?? propagated.sessionId ?? runtime.sessionId,
    userId: options.userId ?? propagated.userId ?? runtime.userId,
    release: options.release ?? propagated.release ?? runtime.release,
    tags: options.tags ?? propagated.tags ?? runtime.tags,
    metadata: {
      ...(propagated.metadata ?? {}),
      ...(options.metadata ?? {}),
    },
    version: options.version ?? propagated.version,
    traceName: options.traceName ?? propagated.traceName,
  };
}

function resolveParentContext(
  options: StartObservationOptions | StartGenerationOptions,
) {
  if (options.parent?.otelSpan) {
    return trace.setSpan(context.active(), options.parent.otelSpan);
  }
  if (options.parentSpanContext?.traceId && options.parentSpanContext.spanId) {
    return trace.setSpanContext(context.active(), {
      traceId: options.parentSpanContext.traceId,
      spanId: options.parentSpanContext.spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  }
  return context.active();
}

function resolveHrTime(value: Date | number | undefined): [number, number] {
  return toHrTime(value) ?? toHrTime(Date.now())!;
}

function toHrTime(value: Date | number | undefined): [number, number] | undefined {
  if (value === undefined) return undefined;
  const raw = value instanceof Date ? value.getTime() : Number(value);
  // OTLP protobuf encode uses BigInt(hrTime[i]); NaN/Infinity/floats throw
  // "Not an integer" and drop the whole export batch.
  if (!Number.isFinite(raw)) return undefined;
  const ms = Math.trunc(raw);
  const seconds = Math.trunc(ms / 1000);
  const nanos = Math.round((ms % 1000) * 1e6);
  return [seconds, nanos];
}

export class Observation {
  protected ended = false;
  protected sawError = false;

  constructor(
    protected readonly span: Span,
    protected readonly runtime: ObservationRuntime,
    protected readonly observationType: ObservationType,
  ) {}

  get spanId(): string {
    return this.span.spanContext().spanId;
  }

  get traceId(): string {
    return this.span.spanContext().traceId;
  }

  get otelSpan(): Span {
    return this.span;
  }

  update(options: UpdateObservationOptions = {}): this {
    if (this.ended) return this;
    const attrs = buildObservationAttributes(options, {
      observationType: this.observationType,
      sessionId: this.runtime.sessionId,
      userId: this.runtime.userId,
      release: this.runtime.release,
      tags: this.runtime.tags,
      redactKeys: this.runtime.redactKeys,
    });
    this.span.setAttributes(toOtelAttributes(attrs));
    if (options.statusMessage) {
      this.sawError = true;
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: options.statusMessage,
      });
    }
    return this;
  }

  setAttributes(attributes: Attributes): this {
    if (this.ended) return this;
    this.span.setAttributes(toOtelAttributes(attributes));
    return this;
  }

  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): this {
    if (this.ended) return this;
    this.span.addEvent(name, attributes);
    return this;
  }

  addContentEvent(name: string, content: JsonValue): this {
    if (this.ended) return this;
    const serialized = serializeCaptured(content, this.runtime.redactKeys);
    if (serialized !== undefined) {
      this.span.addEvent(name, { content: serialized });
    }
    return this;
  }

  end(options: UpdateObservationOptions = {}): void {
    if (this.ended) return;
    const { endTime, ...rest } = options;
    if (Object.keys(rest).length > 0) {
      this.update(rest);
    }
    this.ensureTerminalStatus(options.statusMessage);
    // Always pass integer hrTime. Bare `span.end()` / non-finite endTime yields
    // float/NaN nanos that OTLP BigInt rejects (whole batch dropped).
    this.span.end(resolveHrTime(endTime));
    this.ended = true;
  }

  recordException(error: unknown): this {
    if (this.ended) return this;
    const err = error instanceof Error ? error : new Error(String(error));
    this.span.recordException(err);
    this.sawError = true;
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    return this;
  }

  protected ensureTerminalStatus(statusMessage?: string): void {
    if (statusMessage) {
      this.sawError = true;
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: statusMessage,
      });
      return;
    }
    if (!this.sawError) {
      this.span.setStatus({ code: SpanStatusCode.OK });
    }
  }
}

export class Generation extends Observation {
  update(options: UpdateGenerationOptions = {}): this {
    if (this.ended) return this;
    const attrs = buildGenerationAttributes(options, {
      observationType: "generation",
      sessionId: this.runtime.sessionId,
      userId: this.runtime.userId,
      release: this.runtime.release,
      tags: this.runtime.tags,
      redactKeys: this.runtime.redactKeys,
    });
    this.span.setAttributes(toOtelAttributes(attrs));
    this.emitGenerationEvents(options);
    if (options.statusMessage) {
      this.sawError = true;
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: options.statusMessage,
      });
    }
    return this;
  }

  end(options: UpdateGenerationOptions = {}): void {
    if (this.ended) return;
    const { endTime, ...rest } = options;
    if (Object.keys(rest).length > 0) {
      this.update(rest);
    }
    super.end({ endTime });
  }

  private emitGenerationEvents(
    options: StartGenerationOptions | UpdateGenerationOptions,
  ): void {
    if (options.promptEvent !== undefined) {
      this.addContentEvent("gen_ai.content.prompt", options.promptEvent);
    }
    if (options.completionEvent !== undefined) {
      this.addContentEvent(
        "gen_ai.content.completion",
        options.completionEvent,
      );
    }
    if (options.inferenceDetails !== undefined) {
      this.addContentEvent(
        "gen_ai.client.inference.operation.details",
        options.inferenceDetails,
      );
    }
  }
}

export function startObservationSpan(
  runtime: ObservationRuntime,
  options: StartObservationOptions,
): Observation {
  const observationType = options.asType ?? "span";
  const defaults = mergeDefaults(runtime, options);
  const attrs = buildObservationAttributes(options, {
    observationType,
    ...defaults,
    redactKeys: runtime.redactKeys,
  });
  const startTime = resolveHrTime(options.startTime);
  const span = runtime.tracer.startSpan(
    options.name,
    {
      attributes: toOtelAttributes(attrs),
      startTime,
    },
    resolveParentContext(options),
  );
  return new Observation(span, runtime, observationType);
}

export function startGenerationSpan(
  runtime: ObservationRuntime,
  options: StartGenerationOptions,
): Generation {
  const defaults = mergeDefaults(runtime, options);
  const attrs = buildGenerationAttributes(options, {
    observationType: "generation",
    ...defaults,
    redactKeys: runtime.redactKeys,
  });
  const startTime = resolveHrTime(options.startTime);
  const span = runtime.tracer.startSpan(
    options.name,
    {
      attributes: toOtelAttributes(attrs),
      startTime,
    },
    resolveParentContext(options),
  );
  const generation = new Generation(span, runtime, "generation");
  generation.update({
    promptEvent: options.promptEvent,
    completionEvent: options.completionEvent,
    inferenceDetails: options.inferenceDetails,
  });
  return generation;
}

export async function withObservationContext<T>(
  observation: Observation,
  fn: (observation: Observation) => Promise<T> | T,
): Promise<T> {
  const span = observation.otelSpan;
  const ctx = trace.setSpan(context.active(), span);
  try {
    const result = await context.with(ctx, () => fn(observation));
    observation.end();
    return result;
  } catch (error) {
    observation.recordException(error);
    observation.end();
    throw error;
  }
}

function toOtelAttributes(
  attrs: Attributes,
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}
