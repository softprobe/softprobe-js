import { createRequire } from "node:module";
import type { Attributes, Tracer } from "@opentelemetry/api";

export type SoftprobePrompt = {
  name: string;
  version: number;
  isFallback?: boolean;
};

export type SoftprobeVercelAiSdkIntegrationOptions = {
  tracer?: Tracer;
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

function observationTypeFor(spanType: string): string {
  if (spanType.includes("tool")) return "tool";
  if (spanType.includes("embed")) return "embedding";
  if (
    spanType.includes("languageModel") ||
    spanType.toLowerCase().includes("generate") ||
    spanType.includes("doStream") ||
    spanType.includes("doGenerate")
  ) {
    return "generation";
  }
  if (spanType.includes("rerank")) return "retriever";
  return "span";
}

function firstString(
  context: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!context) return undefined;
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
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
}): Attributes {
  const { runtimeContext, spanType } = params;
  const observationType = observationTypeFor(String(spanType));
  const attributes: Attributes = {
    "sp.observation.type": observationType,
  };

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

/**
 * Langfuse-style AI SDK Telemetry integration for AI SDK 7+.
 * Delegates lifecycle to `@ai-sdk/otel` and enriches Softprobe attributes.
 */
export class SoftprobeVercelAiSdkIntegration {
  private readonly delegate: AiSdkOtelDelegate;

  constructor(options: SoftprobeVercelAiSdkIntegrationOptions = {}) {
    const require = createRequire(import.meta.url);
    let OpenTelemetryCtor: new (opts: unknown) => AiSdkOtelDelegate;
    try {
      OpenTelemetryCtor = require("@ai-sdk/otel").OpenTelemetry;
    } catch (error) {
      throw new Error(
        "@ai-sdk/otel is required for SoftprobeVercelAiSdkIntegration. " +
          "Install ai and @ai-sdk/otel (AI SDK 7), or use createSoftprobeObservationAttributes " +
          "with AI SDK v6 experimental_telemetry.",
        { cause: error },
      );
    }

    this.delegate = new OpenTelemetryCtor({
      tracer: options.tracer,
      enrichSpan: ({
        spanType,
        runtimeContext,
      }: {
        spanType: OpenTelemetrySpanType;
        runtimeContext?: Record<string, unknown>;
      }) =>
        createSoftprobeObservationAttributes({
          spanType,
          runtimeContext,
        }),
    });
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
