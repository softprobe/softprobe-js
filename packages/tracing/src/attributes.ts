import type {
  Attributes,
  GenerationCost,
  GenerationModelParams,
  GenerationUsage,
  JsonValue,
  StartGenerationOptions,
  StartObservationOptions,
  UpdateGenerationOptions,
  UpdateObservationOptions,
} from "./types.js";
import { serializeCaptured } from "./redaction.js";

export function applyMetadata(
  attrs: Attributes,
  metadata?: Record<string, JsonValue>,
): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      attrs[`sp.metadata.${key}`] = value;
    } else {
      const serialized = serializeCaptured(value, []);
      if (serialized !== undefined) attrs[`sp.metadata.${key}`] = serialized;
    }
  }
}

export function buildObservationAttributes(
  options: StartObservationOptions | UpdateObservationOptions,
  defaults: {
    observationType: string;
    sessionId?: string;
    userId?: string;
    release?: string;
    tags?: string[];
    metadata?: Record<string, JsonValue>;
    version?: string;
    traceName?: string;
    redactKeys: string[];
  },
): Attributes {
  const attrs: Attributes = {
    ...(options.attributes ?? {}),
  };

  if ("asType" in options || defaults.observationType) {
    attrs["sp.observation.type"] =
      ("asType" in options && options.asType) || defaults.observationType;
  }

  const sessionId =
    ("sessionId" in options ? options.sessionId : undefined) ??
    defaults.sessionId;
  const userId =
    ("userId" in options ? options.userId : undefined) ?? defaults.userId;
  const release =
    ("release" in options ? options.release : undefined) ?? defaults.release;
  const tags = ("tags" in options ? options.tags : undefined) ?? defaults.tags;
  const version =
    ("version" in options ? options.version : undefined) ?? defaults.version;
  const traceName =
    ("traceName" in options ? options.traceName : undefined) ??
    defaults.traceName;
  const metadata =
    ("metadata" in options ? options.metadata : undefined) ?? defaults.metadata;

  if (sessionId) attrs["sp.session.id"] = sessionId;
  if (userId) attrs["sp.user.id"] = userId;
  if (release) attrs["sp.release"] = release;
  if (tags) attrs["sp.tags"] = tags;
  if (version) attrs["sp.version"] = version;
  if (traceName) attrs["sp.trace.name"] = traceName;
  applyMetadata(attrs, metadata);

  const input = serializeCaptured(options.input, defaults.redactKeys);
  const output = serializeCaptured(options.output, defaults.redactKeys);
  if (input !== undefined) attrs["sp.input"] = input;
  if (output !== undefined) attrs["sp.output"] = output;

  return attrs;
}

export function applyUsage(attrs: Attributes, usage?: GenerationUsage): void {
  if (!usage) return;
  if (usage.inputTokens !== undefined) {
    attrs["gen_ai.usage.input_tokens"] = usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    attrs["gen_ai.usage.output_tokens"] = usage.outputTokens;
  }
  if (usage.totalTokens !== undefined) {
    attrs["gen_ai.usage.total_tokens"] = usage.totalTokens;
  } else if (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined
  ) {
    attrs["gen_ai.usage.total_tokens"] =
      (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
}

export function applyCost(attrs: Attributes, cost?: GenerationCost): void {
  if (!cost) return;
  if (cost.input !== undefined) attrs["sp.cost.input"] = cost.input;
  if (cost.output !== undefined) attrs["sp.cost.output"] = cost.output;
  if (cost.total !== undefined) attrs["sp.cost.total"] = cost.total;
}

export function applyModelParams(
  attrs: Attributes,
  params?: GenerationModelParams,
): void {
  if (!params) return;
  if (params.temperature !== undefined) {
    attrs["gen_ai.request.temperature"] = params.temperature;
  }
  if (params.maxTokens !== undefined) {
    attrs["gen_ai.request.max_tokens"] = params.maxTokens;
  }
}

export function buildGenerationAttributes(
  options: StartGenerationOptions | UpdateGenerationOptions,
  defaults: {
    observationType: string;
    sessionId?: string;
    userId?: string;
    release?: string;
    tags?: string[];
    metadata?: Record<string, JsonValue>;
    version?: string;
    traceName?: string;
    redactKeys: string[];
  },
): Attributes {
  const attrs = buildObservationAttributes(options, defaults);
  attrs["sp.observation.type"] = "generation";

  if ("operationName" in options && options.operationName) {
    attrs["gen_ai.operation.name"] = options.operationName;
  }
  if (options.provider) attrs["gen_ai.provider.name"] = options.provider;
  if ("model" in options && options.model) {
    attrs["gen_ai.request.model"] = options.model;
  }
  if ("responseModel" in options && options.responseModel) {
    attrs["gen_ai.response.model"] = options.responseModel;
  }
  applyModelParams(attrs, options.modelParameters);
  applyUsage(attrs, options.usage);
  applyCost(attrs, options.cost);
  if (options.completionStartTime) {
    attrs["sp.generation.completion_start_time"] = options.completionStartTime;
  }
  if ("responseId" in options && options.responseId) {
    attrs["gen_ai.response.id"] = options.responseId;
  }
  if ("finishReasons" in options && options.finishReasons) {
    attrs["gen_ai.response.finish_reasons"] = options.finishReasons;
  }
  if (options.prompt?.id) attrs["sp.prompt.id"] = options.prompt.id;
  if (options.prompt?.name) attrs["sp.prompt.name"] = options.prompt.name;
  if (options.prompt?.version !== undefined) {
    attrs["sp.prompt.version"] = options.prompt.version;
  }
  return attrs;
}
