import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { AgentAction, AgentFinish } from "@langchain/core/agents";
import type { DocumentInterface } from "@langchain/core/documents";
import type { Serialized } from "@langchain/core/load/serializable";
import { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import type { ChainValues } from "@langchain/core/utils/types";
import {
  SoftprobeClient,
  type Attributes,
  type Generation,
  type Observation,
  type JsonValue,
  recordToolCalls,
  recordToolDefinitions,
  toolResultEventPayload,
  toolSpanAttributes,
  normalizeToolCalls,
} from "@softprobe/tracing";

type Tracked = Observation | Generation;

export type CallbackHandlerParams = {
  softprobeClient: SoftprobeClient;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  metadata?: Record<string, JsonValue>;
  version?: string;
  parentSpanContext?: { traceId: string; spanId: string };
};

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function messageToDict(message: BaseMessage): JsonValue {
  const roleMap: Record<string, string> = {
    human: "user",
    ai: "assistant",
    system: "system",
    tool: "tool",
    function: "function",
  };
  const raw = message.getType?.() ?? message._getType?.() ?? "unknown";
  const payload: Record<string, JsonValue> = {
    role: roleMap[raw] ?? raw,
    content: asJsonValue(message.content),
  };
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (toolCalls) {
    const normalized = normalizeToolCalls(toolCalls);
    payload.tool_calls = asJsonValue(
      normalized.length ? normalized : toolCalls,
    );
  }
  const toolCallId = (message as { tool_call_id?: string }).tool_call_id;
  if (toolCallId) payload.tool_call_id = toolCallId;
  const name = (message as { name?: string }).name;
  if (name) payload.name = name;
  return payload;
}

export class CallbackHandler extends BaseCallbackHandler {
  name = "SoftprobeCallbackHandler";

  private readonly client: SoftprobeClient;
  private readonly sessionId?: string;
  private readonly userId?: string;
  private readonly tags: string[];
  private readonly metadata?: Record<string, JsonValue>;
  private readonly version?: string;
  private readonly parentSpanContext?: { traceId: string; spanId: string };
  private readonly runs = new Map<string, Tracked>();
  private readonly completionStart = new Map<string, string>();
  private readonly toolMeta = new Map<
    string,
    { name: string; toolCallId?: string }
  >();
  public lastTraceId: string | null = null;

  constructor(params: CallbackHandlerParams) {
    super();
    this.client = params.softprobeClient;
    this.sessionId = params.sessionId;
    this.userId = params.userId;
    this.tags = params.tags ?? [];
    this.metadata = params.metadata;
    this.version = params.version;
    this.parentSpanContext = params.parentSpanContext;
  }

  private parent(parentRunId?: string): Observation | undefined {
    if (!parentRunId) return undefined;
    return this.runs.get(parentRunId);
  }

  private start(options: {
    runId: string;
    parentRunId?: string;
    name: string;
    asType: "chain" | "agent" | "tool" | "retriever" | "generation";
    input?: JsonValue;
    metadata?: Record<string, unknown>;
    tags?: string[];
    model?: string;
    operationName?: string;
    temperature?: number;
    maxTokens?: number;
    promptEvent?: JsonValue;
    attributes?: Attributes;
  }): Tracked {
    const parent = this.parent(options.parentRunId);
    const mergedTags = [...new Set([...(options.tags ?? []), ...this.tags])];
    const mergedMeta = {
      ...(this.metadata ?? {}),
      ...((options.metadata as Record<string, JsonValue> | undefined) ?? {}),
    };
    const common = {
      name: options.name,
      sessionId: this.sessionId,
      userId: this.userId,
      tags: mergedTags.length ? mergedTags : undefined,
      metadata: Object.keys(mergedMeta).length ? mergedMeta : undefined,
      version: this.version,
      input: options.input,
      attributes: options.attributes,
      parent,
      parentSpanContext:
        !parent && this.parentSpanContext ? this.parentSpanContext : undefined,
    };

    let obs: Tracked;
    if (options.asType === "generation") {
      obs = this.client.startGeneration({
        ...common,
        model: options.model,
        operationName: options.operationName,
        modelParameters: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
        },
        promptEvent: options.promptEvent,
      });
    } else {
      obs = this.client.startObservation({
        ...common,
        asType: options.asType,
      });
    }
    this.runs.set(options.runId, obs);
    if (!parent) this.lastTraceId = obs.traceId;
    return obs;
  }

  private end(
    runId: string,
    update: {
      output?: JsonValue;
      statusMessage?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      responseModel?: string;
      completionEvent?: JsonValue;
      finishReasons?: string[];
      attributes?: Attributes;
    } = {},
  ): void {
    const obs = this.runs.get(runId);
    this.runs.delete(runId);
    this.completionStart.delete(runId);
    this.toolMeta.delete(runId);
    if (!obs) return;
    obs.end(update);
  }

  async handleLLMNewToken(
    _token: string,
    _idx: unknown,
    runId: string,
  ): Promise<void> {
    if (!this.completionStart.has(runId) && this.runs.has(runId)) {
      const iso = new Date().toISOString();
      this.completionStart.set(runId, iso);
      const obs = this.runs.get(runId);
      if (obs && "update" in obs) {
        (obs as Generation).update({ completionStartTime: iso });
      }
    }
  }

  async handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    name?: string,
  ): Promise<void> {
    const runName =
      name ?? chain.id?.at(-1)?.toString() ?? chain.name ?? "Langchain Run";
    const asType = /agent/i.test(runName) ? "agent" : "chain";
    this.start({
      runId,
      parentRunId,
      name: runName,
      asType,
      input: inputs as JsonValue,
      metadata,
      tags,
    });
  }

  async handleChainEnd(outputs: ChainValues, runId: string): Promise<void> {
    this.end(runId, { output: outputs as JsonValue });
  }

  async handleChainError(err: Error, runId: string): Promise<void> {
    this.end(runId, { statusMessage: String(err) });
  }

  async handleAgentAction(
    action: AgentAction,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    // LangChain reuses the agent runId here; do not overwrite the agent span.
    if (this.runs.has(runId)) return;
    this.start({
      runId,
      parentRunId,
      name: action.tool,
      asType: "tool",
      input: action.toolInput as JsonValue,
      attributes: toolSpanAttributes({
        toolName: action.tool,
        kind: "function",
        status: "ok",
      }),
    });
  }

  async handleAgentEnd(action: AgentFinish, runId: string): Promise<void> {
    this.end(runId, { output: action.returnValues as JsonValue });
  }

  async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    const flat = messages.flat().map(messageToDict);
    const invocation = (extraParams?.invocation_params ?? {}) as Record<
      string,
      unknown
    >;
    const model =
      (typeof invocation.model === "string" && invocation.model) ||
      (typeof metadata?.ls_model_name === "string" && metadata.ls_model_name) ||
      llm.id?.at(-1)?.toString();
    const obs = this.start({
      runId,
      parentRunId,
      name: name ?? llm.id?.at(-1)?.toString() ?? "ChatModel",
      asType: "generation",
      input: { messages: flat },
      metadata,
      tags,
      model: model || undefined,
      operationName: "chat",
      temperature:
        typeof invocation.temperature === "number"
          ? invocation.temperature
          : undefined,
      maxTokens:
        typeof invocation.max_tokens === "number"
          ? invocation.max_tokens
          : undefined,
      promptEvent: flat,
    });
    if (invocation.tools !== undefined) {
      recordToolDefinitions(obs, invocation.tools);
    }
  }

  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    const invocation = (extraParams?.invocation_params ?? {}) as Record<
      string,
      unknown
    >;
    const model =
      (typeof invocation.model === "string" && invocation.model) ||
      (typeof metadata?.ls_model_name === "string" && metadata.ls_model_name) ||
      undefined;
    const obs = this.start({
      runId,
      parentRunId,
      name: name ?? llm.id?.at(-1)?.toString() ?? "LLM",
      asType: "generation",
      input: { prompts },
      metadata,
      tags,
      model,
      operationName: "completion",
      promptEvent: prompts,
    });
    if (invocation.tools !== undefined) {
      recordToolDefinitions(obs, invocation.tools);
    }
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const toolCalls: unknown[] = [];
    const finishReasons: string[] = [];
    const generations = output.generations.flat().map((gen): JsonValue => {
      const message = (gen as { message?: BaseMessage }).message;
      if (message) {
        const payload = messageToDict(message);
        if (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          Array.isArray(payload.tool_calls) &&
          payload.tool_calls.length
        ) {
          toolCalls.push(...payload.tool_calls);
          finishReasons.push("tool_calls");
        } else {
          finishReasons.push("stop");
        }
        return payload;
      }
      finishReasons.push("stop");
      return { content: gen.text };
    });
    const tokenUsage =
      (output.llmOutput?.tokenUsage as Record<string, number> | undefined) ??
      (output.llmOutput?.token_usage as Record<string, number> | undefined);
    const obs = this.runs.get(runId);
    if (obs && toolCalls.length) {
      recordToolCalls(obs, toolCalls);
    }
    this.end(runId, {
      output: { generations },
      completionEvent: generations,
      usage: tokenUsage
        ? {
            inputTokens: tokenUsage.promptTokens ?? tokenUsage.prompt_tokens,
            outputTokens:
              tokenUsage.completionTokens ?? tokenUsage.completion_tokens,
            totalTokens: tokenUsage.totalTokens ?? tokenUsage.total_tokens,
          }
        : undefined,
      finishReasons: finishReasons.length ? finishReasons : ["stop"],
    });
  }

  async handleLLMError(err: Error, runId: string): Promise<void> {
    this.end(runId, { statusMessage: String(err) });
  }

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    const toolName =
      name ?? tool.name ?? tool.id?.at(-1)?.toString() ?? "tool";
    // Only correlate with a provider-supplied id (matches generation
    // sp.tool.call_ids); never fabricate one from the LangChain runId.
    const toolCallId =
      (typeof metadata?.tool_call_id === "string" && metadata.tool_call_id) ||
      (typeof metadata?.toolCallId === "string" && metadata.toolCallId) ||
      undefined;
    this.toolMeta.set(runId, { name: toolName, toolCallId });
    this.start({
      runId,
      parentRunId,
      name: toolName,
      asType: "tool",
      input,
      metadata,
      tags,
      attributes: toolSpanAttributes({
        toolName,
        toolCallId,
        kind: "function",
        status: "ok",
      }),
    });
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    const obs = this.runs.get(runId);
    const meta = this.toolMeta.get(runId);
    const content = asJsonValue(output);
    if (obs) {
      obs.addContentEvent(
        "gen_ai.tool.message",
        toolResultEventPayload({
          name: meta?.name ?? "tool",
          content,
          toolCallId: meta?.toolCallId,
        }),
      );
    }
    this.end(runId, {
      output: content,
      attributes: toolSpanAttributes({ status: "ok" }),
    });
  }

  async handleToolError(err: Error, runId: string): Promise<void> {
    this.end(runId, {
      statusMessage: String(err),
      attributes: toolSpanAttributes({ status: "error" }),
    });
  }

  async handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    this.start({
      runId,
      parentRunId,
      name: name ?? retriever.name ?? "retriever",
      asType: "retriever",
      input: { query },
      metadata,
      tags,
    });
  }

  async handleRetrieverEnd(
    documents: DocumentInterface[],
    runId: string,
  ): Promise<void> {
    this.end(runId, {
      output: {
        documents: documents.map((doc) => ({
          pageContent: doc.pageContent,
          metadata: doc.metadata,
        })),
      },
    });
  }

  async handleRetrieverError(err: Error, runId: string): Promise<void> {
    this.end(runId, { statusMessage: String(err) });
  }
}
