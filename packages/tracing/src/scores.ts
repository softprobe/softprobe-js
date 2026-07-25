import type { CreateScoreOptions, ScoreRequest } from "./types.js";

export function buildScoreRequest(options: CreateScoreOptions): ScoreRequest {
  if (!options.scoreId?.trim()) {
    throw new Error("scoreId is required");
  }
  if (!options.name?.trim()) {
    throw new Error("name is required");
  }
  if (!options.dataType) {
    throw new Error("dataType is required");
  }
  if (!options.source) {
    throw new Error("source is required");
  }

  const hasSpan = Boolean(options.spanId);
  const hasTrace = Boolean(options.traceId);
  const hasSession = Boolean(options.sessionId);
  if (!hasSpan && !hasTrace && !hasSession) {
    throw new Error("score must target spanId, traceId, and/or sessionId");
  }

  switch (options.dataType) {
    case "numeric":
      if (options.numericValue === undefined || options.numericValue === null) {
        throw new Error("numeric scores require numericValue");
      }
      break;
    case "categorical":
    case "text":
      if (options.stringValue === undefined || options.stringValue === null) {
        throw new Error(`${options.dataType} scores require stringValue`);
      }
      break;
    case "boolean":
      if (options.booleanValue === undefined || options.booleanValue === null) {
        throw new Error("boolean scores require booleanValue");
      }
      break;
    default:
      throw new Error(`unsupported dataType: ${options.dataType as string}`);
  }

  const timestamp =
    options.timestamp instanceof Date
      ? options.timestamp.toISOString()
      : (options.timestamp ?? new Date().toISOString());

  return {
    score_id: options.scoreId,
    timestamp,
    trace_id: options.traceId ?? null,
    span_id: options.spanId ?? null,
    session_id: options.sessionId ?? null,
    name: options.name,
    data_type: options.dataType,
    numeric_value: options.numericValue ?? null,
    string_value: options.stringValue ?? null,
    boolean_value: options.booleanValue ?? null,
    source: options.source,
    comment: options.comment ?? null,
    config_id: options.configId ?? null,
    author_id: options.authorId ?? null,
    metadata: options.metadata ?? {},
  };
}

export class HttpScoreTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly publicKey: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs: number,
  ) {}

  async createScore(request: ScoreRequest): Promise<void> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/llm/scores`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.publicKey}`,
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `score create failed (${response.status}): ${body || response.statusText}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
