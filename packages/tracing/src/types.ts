export const OBSERVATION_TYPES = [
  "span",
  "event",
  "generation",
  "agent",
  "tool",
  "chain",
  "retriever",
  "evaluator",
  "embedding",
  "guardrail",
] as const;

export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export type AttributeValue = string | number | boolean | string[] | null;

export type Attributes = Record<string, AttributeValue>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SoftprobeConfig {
  publicKey: string;
  baseUrl: string;
  /** Defaults to `{baseUrl}/v1/traces` when omitted. */
  otlpEndpoint?: string;
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  release?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  redactKeys?: string[];
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface StartObservationOptions {
  name: string;
  asType?: ObservationType;
  attributes?: Attributes;
  input?: JsonValue;
  output?: JsonValue;
  sessionId?: string;
  userId?: string;
  release?: string;
  tags?: string[];
  metadata?: Record<string, JsonValue>;
  version?: string;
  traceName?: string;
  /** Explicit Softprobe parent observation. */
  parent?: { otelSpan: import("@opentelemetry/api").Span };
  /** Remote/distributed parent context. */
  parentSpanContext?: {
    traceId: string;
    spanId: string;
  };
  /**
   * Start a brand-new trace even when an ambient span is active on
   * `context.active()` (e.g. a host application's OTEL context adopting this
   * span into its own trace). Ignored when `parent` or `parentSpanContext`
   * is set.
   */
  root?: boolean;
  /** Historical span start (Date or epoch millis). */
  startTime?: Date | number;
}

export interface StartToolOptions extends Omit<StartObservationOptions, "asType"> {
  toolName?: string;
  toolCallId?: string;
  kind?: string;
  status?: string;
  index?: number;
  mcpServer?: string;
  mcpTool?: string;
}

export interface UpdateObservationOptions {
  attributes?: Attributes;
  input?: JsonValue;
  output?: JsonValue;
  statusMessage?: string;
  /** Historical span end (Date or epoch millis). */
  endTime?: Date | number;
}

export interface GenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GenerationCost {
  input?: number;
  output?: number;
  total?: number;
}

export interface GenerationModelParams {
  temperature?: number;
  maxTokens?: number;
}

export interface StartGenerationOptions extends StartObservationOptions {
  asType?: "generation";
  model?: string;
  modelParameters?: GenerationModelParams;
  provider?: string;
  operationName?: string;
  usage?: GenerationUsage;
  cost?: GenerationCost;
  completionStartTime?: string;
  prompt?: {
    id?: string;
    name?: string;
    version?: number;
  };
  promptEvent?: JsonValue;
  completionEvent?: JsonValue;
  inferenceDetails?: JsonValue;
}

export interface UpdateGenerationOptions extends UpdateObservationOptions {
  model?: string;
  responseModel?: string;
  modelParameters?: GenerationModelParams;
  provider?: string;
  usage?: GenerationUsage;
  cost?: GenerationCost;
  completionStartTime?: string;
  responseId?: string;
  finishReasons?: string[];
  prompt?: {
    id?: string;
    name?: string;
    version?: number;
  };
  promptEvent?: JsonValue;
  completionEvent?: JsonValue;
  inferenceDetails?: JsonValue;
}

export type ScoreDataType = "numeric" | "categorical" | "boolean" | "text";
export type ScoreSource = "api" | "user" | "evaluator" | "annotation";

export interface CreateScoreOptions {
  scoreId: string;
  name: string;
  dataType: ScoreDataType;
  source: ScoreSource;
  timestamp?: string | Date;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  numericValue?: number;
  stringValue?: string;
  booleanValue?: boolean;
  comment?: string;
  configId?: string;
  authorId?: string;
  metadata?: Record<string, string>;
}

export interface ScoreRequest {
  score_id: string;
  timestamp: string;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  name: string;
  data_type: ScoreDataType;
  numeric_value: number | null;
  string_value: string | null;
  boolean_value: boolean | null;
  source: ScoreSource;
  comment: string | null;
  config_id: string | null;
  author_id: string | null;
  metadata: Record<string, string>;
}

export interface ScoreTransport {
  createScore(request: ScoreRequest): Promise<void>;
}

export interface NormalizedSpanEvent {
  name: string;
  attributes: Record<string, string | number | boolean | null>;
}

export interface NormalizedSpan {
  name: string;
  observation_type: ObservationType;
  parent_name: string | null;
  attributes: Attributes;
  events: NormalizedSpanEvent[];
  status_code: "UNSET" | "OK" | "ERROR";
  status_message: string | null;
}
