import type { SoftprobeClient } from "./client.js";
import {
  normalizeToolCalls,
  recordToolCalls,
  recordToolDefinitions,
} from "./tools.js";
import type { JsonValue } from "./types.js";

export interface ObserveOpenAIConfig {
  softprobeClient: SoftprobeClient;
  generationName?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  release?: string;
}

const SOFTPROBE_KEYS = new Set([
  "name",
  "sessionId",
  "session_id",
  "userId",
  "user_id",
  "metadata",
  "tags",
  "release",
]);

function providerFromBaseUrl(baseUrl: unknown): string {
  const value = String(baseUrl ?? "");
  if (value.includes("generativelanguage.googleapis.com")) return "google";
  if (value.toLowerCase().includes("azure")) return "azure";
  return "openai";
}

function splitArgs(input: Record<string, unknown>): {
  softprobe: Record<string, unknown>;
  openai: Record<string, unknown>;
} {
  const softprobe: Record<string, unknown> = {};
  const openai: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SOFTPROBE_KEYS.has(key)) softprobe[key] = value;
    else openai[key] = value;
  }
  return { softprobe, openai };
}

function usageFromResponse(response: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}):
  | { inputTokens: number; outputTokens: number; totalTokens: number }
  | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function completionOutput(response: {
  choices?: Array<{ message?: unknown; finish_reason?: string | null }>;
}): JsonValue {
  const message = response.choices?.[0]?.message;
  return (message ?? response) as JsonValue;
}

function messageToolCalls(response: {
  choices?: Array<{ message?: { tool_calls?: unknown } }>;
}): unknown[] {
  const raw = response.choices?.[0]?.message?.tool_calls;
  return Array.isArray(raw) ? raw : [];
}

function requestInput(
  messages: JsonValue | undefined,
  tools: unknown,
  toolChoice: unknown,
): JsonValue | undefined {
  if (messages === undefined && tools === undefined && toolChoice === undefined) {
    return undefined;
  }
  const payload: Record<string, unknown> = {};
  if (messages !== undefined) payload.messages = messages;
  if (tools !== undefined) payload.tools = tools;
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  return payload as JsonValue;
}

function finishReasons(response: {
  choices?: Array<{ finish_reason?: string | null }>;
}): string[] | undefined {
  const reasons = (response.choices ?? [])
    .map((choice) => choice.finish_reason)
    .filter((value): value is string => Boolean(value));
  return reasons.length > 0 ? reasons : undefined;
}

async function traceChatCreate(
  original: (...args: unknown[]) => unknown,
  thisArg: unknown,
  args: unknown[],
  config: ObserveOpenAIConfig,
  openaiClient: { baseURL?: unknown; baseUrl?: unknown },
  state: {
    lastGenerationSpanId?: string;
    lastGenerationTraceId?: string;
  },
): Promise<unknown> {
  const raw = (args[0] ?? {}) as Record<string, unknown>;
  const { softprobe, openai } = splitArgs(raw);
  if (openai.stream) {
    throw new Error(
      "observeOpenAI streaming is not supported yet; call without stream: true",
    );
  }

  const name =
    (softprobe.name as string | undefined) ??
    config.generationName ??
    "OpenAI-generation";
  const sessionId =
    (softprobe.sessionId as string | undefined) ??
    (softprobe.session_id as string | undefined) ??
    config.sessionId;
  const userId =
    (softprobe.userId as string | undefined) ??
    (softprobe.user_id as string | undefined) ??
    config.userId;
  const tags = (softprobe.tags as string[] | undefined) ?? config.tags;
  const release = (softprobe.release as string | undefined) ?? config.release;
  const model = openai.model as string | undefined;
  const messages = openai.messages as JsonValue | undefined;
  const tools = openai.tools;
  const toolChoice = openai.tool_choice;
  const temperature = openai.temperature as number | undefined;
  const maxTokens = (openai.max_tokens ?? openai.max_completion_tokens) as
    | number
    | undefined;
  const provider = providerFromBaseUrl(
    openaiClient.baseURL ?? openaiClient.baseUrl,
  );

  const generation = config.softprobeClient.startGeneration({
    name,
    sessionId,
    userId,
    tags,
    release,
    model,
    provider,
    operationName: "chat",
    modelParameters: {
      temperature,
      maxTokens,
    },
    input: requestInput(messages, tools, toolChoice),
    promptEvent: messages,
    inferenceDetails: {
      provider,
      model: model ?? null,
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    } as JsonValue,
  });
  if (tools !== undefined) {
    recordToolDefinitions(generation, tools);
  }
  state.lastGenerationSpanId = generation.spanId;
  state.lastGenerationTraceId = generation.traceId;

  try {
    const response = (await original.apply(thisArg, [openai])) as {
      model?: string;
      id?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      choices?: Array<{
        message?: { tool_calls?: unknown; [key: string]: unknown };
        finish_reason?: string | null;
      }>;
    };
    let output = completionOutput(response);
    const rawToolCalls = messageToolCalls(response);
    const normalizedCalls = normalizeToolCalls(rawToolCalls);
    if (
      normalizedCalls.length > 0 &&
      output &&
      typeof output === "object" &&
      !Array.isArray(output)
    ) {
      output = { ...(output as Record<string, unknown>), tool_calls: normalizedCalls };
    }
    if (normalizedCalls.length > 0) {
      recordToolCalls(generation, rawToolCalls);
    }
    generation.update({
      responseModel: response.model ?? model,
      responseId: response.id,
      usage: usageFromResponse(response),
      finishReasons: finishReasons(response),
      output,
      completionEvent: output,
    });
    generation.end();
    return response;
  } catch (error) {
    generation.recordException(error);
    generation.end();
    throw error;
  }
}

/**
 * Langfuse-style Proxy wrapper around an OpenAI SDK client.
 * Traces `chat.completions.create` (non-streaming) as Softprobe generations.
 *
 * Records tool definitions and assistant `tool_calls` on the generation.
 * Tool *execution* spans are app-owned — wrap each run with `startTool`.
 */
export function observeOpenAI<T extends object>(
  sdk: T,
  config: ObserveOpenAIConfig,
): T & {
  lastGenerationSpanId?: string;
  lastGenerationTraceId?: string;
} {
  const state: {
    lastGenerationSpanId?: string;
    lastGenerationTraceId?: string;
  } = {};

  const proxied = new Proxy(sdk, {
    get(target, prop, receiver) {
      if (prop === "lastGenerationSpanId") return state.lastGenerationSpanId;
      if (prop === "lastGenerationTraceId") return state.lastGenerationTraceId;

      const value = Reflect.get(target, prop, receiver);

      if (prop === "chat") {
        return new Proxy(value as object, {
          get(chatTarget, chatProp, chatReceiver) {
            const chatValue = Reflect.get(chatTarget, chatProp, chatReceiver);
            if (chatProp === "completions") {
              return new Proxy(chatValue as object, {
                get(completionsTarget, completionsProp, completionsReceiver) {
                  const method = Reflect.get(
                    completionsTarget,
                    completionsProp,
                    completionsReceiver,
                  );
                  if (
                    completionsProp === "create" &&
                    typeof method === "function"
                  ) {
                    return (...args: unknown[]) =>
                      traceChatCreate(
                        method as (...args: unknown[]) => unknown,
                        completionsTarget,
                        args,
                        config,
                        sdk as { baseURL?: unknown; baseUrl?: unknown },
                        state,
                      );
                  }
                  return typeof method === "function"
                    ? method.bind(completionsTarget)
                    : method;
                },
              });
            }
            return typeof chatValue === "function"
              ? chatValue.bind(chatTarget)
              : chatValue;
          },
        });
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T & {
    lastGenerationSpanId?: string;
    lastGenerationTraceId?: string;
  };

  return proxied;
}

export const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
