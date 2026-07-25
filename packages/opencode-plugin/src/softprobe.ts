import {
  SoftprobeClient,
  recordToolCalls,
  type Generation,
  type JsonValue,
  type Observation,
  type SoftprobeClientOptions,
} from "@softprobe/tracing";
import { inferToolKind } from "./tool-kind.js";
import type {
  AssistantGenerationInput,
  MessagePart,
  SessionErrorInfo,
  UserMessageInput,
} from "./types.js";

type TurnObservation = {
  observation: Observation;
  sessionID: string;
  messageID?: string;
};

type ToolObservation = {
  observation: Observation;
  sessionID: string;
  tool: string;
  started: number;
};

type ActiveGenerationStep = {
  observation: Generation;
  sessionID: string;
  agent?: string;
  model?: { providerID: string; id: string; variant?: string };
  started?: number;
  snapshot?: string;
};

function asJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return value as JsonValue;
  }
  return String(value);
}

function formatUserParts(parts: MessagePart[]): JsonValue {
  const formatted: JsonValue[] = parts.map((part) => {
    if (part.type === "text") {
      return { type: part.type, text: part.text ?? "" };
    }
    if (part.type === "file") {
      const out: Record<string, JsonValue> = { type: part.type };
      if (part.filename !== undefined) out.filename = part.filename;
      if (part.url !== undefined) out.url = part.url;
      return out;
    }
    if (part.type === "agent") {
      const out: Record<string, JsonValue> = { type: part.type };
      if (part.name !== undefined) out.name = part.name;
      return out;
    }
    if (part.type === "subtask") {
      const out: Record<string, JsonValue> = { type: part.type };
      if (part.prompt !== undefined) out.prompt = part.prompt;
      if (part.agent !== undefined) out.agent = part.agent;
      return out;
    }
    if (part.type === "tool") {
      const out: Record<string, JsonValue> = { type: part.type };
      if (part.tool !== undefined) out.tool = part.tool;
      if (part.state?.title !== undefined) out.title = part.state.title;
      return out;
    }
    return { type: part.type };
  });
  return { role: "user", parts: formatted };
}

function getSessionErrorMessage(error: SessionErrorInfo): string {
  if (typeof error.message === "string" && error.message) return error.message;
  if (typeof error.data?.message === "string" && error.data.message) {
    return error.data.message;
  }
  return error.name;
}

function getCompletedReasoningTimestamp(part: MessagePart): number | undefined {
  if (typeof part.time?.completed === "number") return part.time.completed;
  if (typeof part.time?.end === "number") return part.time.end;
  return undefined;
}

export type SoftprobeSessionTracerOptions = SoftprobeClientOptions;

/**
 * Maps OpenCode session hooks to Softprobe Part A observations.
 * Construct with an injected SoftprobeClient (tests) or via {@link createSoftprobeSessionTracer}.
 */
export class SoftprobeSessionTracer {
  readonly client: SoftprobeClient;
  private readonly userId?: string;

  private readonly abortedSessions = new Set<string>();
  private readonly tracedMessageIds = new Set<string>();
  private readonly tracedGenerationIds = new Set<string>();
  private readonly tracedEventIds = new Set<string>();
  private readonly tracedReasoningIds = new Set<string>();
  private readonly tracedToolCallIds = new Set<string>();
  private readonly pendingReasoningByMessageId = new Map<
    string,
    Map<string, MessagePart>
  >();
  private readonly assistantParts = new Map<string, Map<string, MessagePart>>();
  private readonly generationByMessageId = new Map<string, Generation>();
  private readonly turnByMessageId = new Map<string, TurnObservation>();
  private readonly latestTurnBySession = new Map<string, TurnObservation>();
  private readonly activeTools = new Map<string, ToolObservation>();
  private readonly activeGenerations = new Map<string, ActiveGenerationStep>();
  private readonly generationParents = new Map<string, Generation>();

  constructor(client: SoftprobeClient, options: { userId?: string } = {}) {
    this.client = client;
    this.userId = options.userId;
  }

  clearTraceState(): void {
    this.assistantParts.clear();
    this.abortedSessions.clear();
    this.tracedEventIds.clear();
    this.tracedReasoningIds.clear();
    this.tracedToolCallIds.clear();
    this.pendingReasoningByMessageId.clear();
    this.generationByMessageId.clear();
    this.generationParents.clear();
    this.turnByMessageId.clear();
    this.latestTurnBySession.clear();
  }

  endActiveToolObservations(sessionID?: string, error?: SessionErrorInfo): void {
    for (const [callID, active] of this.activeTools) {
      if (sessionID && active.sessionID !== sessionID) continue;
      if (error && error.name !== "MessageAbortedError") {
        active.observation.recordException(
          new Error(getSessionErrorMessage(error)),
        );
        active.observation.end({
          attributes: { "sp.tool.status": "error" },
        });
      } else if (error?.name === "MessageAbortedError") {
        active.observation.end({
          attributes: { "sp.tool.status": "cancelled" },
        });
      } else {
        active.observation.end();
      }
      this.activeTools.delete(callID);
    }
  }

  endActiveGenerationSteps(sessionID?: string, error?: SessionErrorInfo): void {
    for (const [activeSessionID, step] of this.activeGenerations) {
      if (sessionID && activeSessionID !== sessionID) continue;
      if (error && error.name !== "MessageAbortedError") {
        step.observation.recordException(
          new Error(getSessionErrorMessage(error)),
        );
        step.observation.end();
      } else {
        step.observation.end();
      }
      this.activeGenerations.delete(activeSessionID);
      this.generationParents.delete(activeSessionID);
    }
  }

  endActiveTurnObservations(): void {
    for (const turn of new Set(this.latestTurnBySession.values())) {
      turn.observation.end();
    }
    this.turnByMessageId.clear();
    this.latestTurnBySession.clear();
  }

  finalizeSessionTracing(): void {
    this.endActiveToolObservations();
    this.endActiveGenerationSteps();
    this.endActiveTurnObservations();
    this.clearTraceState();
  }

  async forceFlush(): Promise<void> {
    await this.client.forceFlush();
  }

  async shutdown(): Promise<void> {
    this.finalizeSessionTracing();
    await this.client.shutdown();
  }

  private getTurn(
    sessionID: string,
    messageID?: string,
  ): TurnObservation | undefined {
    return (
      (messageID ? this.turnByMessageId.get(messageID) : undefined) ??
      this.latestTurnBySession.get(sessionID)
    );
  }

  private generationParent(sessionID: string): Generation | undefined {
    return (
      this.activeGenerations.get(sessionID)?.observation ??
      this.generationParents.get(sessionID)
    );
  }

  private sessionAttrs(sessionID: string) {
    return {
      sessionId: sessionID,
      ...(this.userId ? { userId: this.userId } : {}),
    };
  }

  traceUserMessage(input: UserMessageInput): void {
    if (input.messageID && this.tracedMessageIds.has(input.messageID)) {
      return;
    }

    this.abortedSessions.delete(input.sessionID);
    const formattedInput = formatUserParts(input.parts);

    if (input.messageID) {
      this.tracedMessageIds.add(input.messageID);
    }

    const previous = this.latestTurnBySession.get(input.sessionID);
    if (previous) {
      previous.observation.end();
      this.latestTurnBySession.delete(input.sessionID);
    }
    this.generationParents.delete(input.sessionID);

    const turn = this.client.startAgent({
      name: "opencode.turn",
      ...this.sessionAttrs(input.sessionID),
      input: formattedInput,
      metadata: {
        messageID: input.messageID ?? null,
        agent: input.agent ?? null,
        providerID: input.model?.providerID ?? null,
        modelID: input.model?.modelID ?? null,
      },
    });

    const observation: TurnObservation = {
      observation: turn,
      sessionID: input.sessionID,
      messageID: input.messageID,
    };

    if (input.messageID) {
      this.turnByMessageId.set(input.messageID, observation);
    }
    this.latestTurnBySession.set(input.sessionID, observation);

    const userEvent = this.client.startEvent({
      name: "opencode.message.user",
      parent: turn,
      ...this.sessionAttrs(input.sessionID),
      input: formattedInput,
      metadata: {
        messageID: input.messageID ?? null,
        agent: input.agent ?? null,
        providerID: input.model?.providerID ?? null,
        modelID: input.model?.modelID ?? null,
      },
    });
    userEvent.end();
  }

  startActiveGenerationStep(input: {
    sessionID: string;
    agent: string;
    model: { providerID: string; id: string; variant?: string };
    started: number;
    snapshot?: string;
  }): void {
    const existing = this.activeGenerations.get(input.sessionID);
    if (existing && !existing.model) {
      existing.observation.update({
        model: input.model.id,
        provider: input.model.providerID,
      });
      existing.observation.setAttributes({
        "sp.metadata.agent": input.agent,
        "sp.metadata.providerID": input.model.providerID,
        ...(input.model.variant
          ? { "sp.metadata.variant": input.model.variant }
          : {}),
        ...(input.snapshot ? { "sp.metadata.snapshot": input.snapshot } : {}),
      });
      this.activeGenerations.set(input.sessionID, {
        ...existing,
        agent: input.agent,
        model: input.model,
        started: input.started,
        snapshot: input.snapshot,
      });
      return;
    }

    if (existing) {
      existing.observation.end({ endTime: input.started });
      this.activeGenerations.delete(input.sessionID);
    }

    const turn = this.getTurn(input.sessionID);
    if (!turn) return;

    const generation = this.client.startGeneration({
      name: "opencode.generation",
      parent: turn.observation,
      ...this.sessionAttrs(input.sessionID),
      startTime: input.started,
      model: input.model.id,
      provider: input.model.providerID,
      operationName: "chat",
      metadata: {
        agent: input.agent,
        providerID: input.model.providerID,
        variant: input.model.variant ?? null,
        snapshot: input.snapshot ?? null,
      },
    });

    this.activeGenerations.set(input.sessionID, {
      observation: generation,
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      started: input.started,
      snapshot: input.snapshot,
    });
    this.generationParents.set(input.sessionID, generation);
  }

  rememberAssistantPart(part: MessagePart): void {
    if (!part.id || !part.messageID) return;
    const parts =
      this.assistantParts.get(part.messageID) ?? new Map<string, MessagePart>();
    parts.set(part.id, part);
    this.assistantParts.set(part.messageID, parts);
  }

  private getAssistantText(messageID: string): string {
    return Array.from(this.assistantParts.get(messageID)?.values() ?? [])
      .filter((part) => part.type === "text" && Boolean(part.text))
      .map((part) => part.text ?? "")
      .join("");
  }

  private getAssistantToolCalls(messageID: string) {
    return Array.from(this.assistantParts.get(messageID)?.values() ?? [])
      .filter((part) => part.type === "tool" && part.tool)
      .map((part, index) => ({
        id: part.id,
        name: part.tool!,
        arguments: {},
        index,
      }));
  }

  private flushPendingReasoning(messageID: string, parent: Generation): void {
    const pending = this.pendingReasoningByMessageId.get(messageID);
    this.pendingReasoningByMessageId.delete(messageID);
    if (!pending) return;
    for (const part of pending.values()) {
      const completed = getCompletedReasoningTimestamp(part);
      if (completed === undefined || !part.text?.trim()) continue;
      this.traceReasoning({
        reasoningID: part.id ?? `part-${completed}`,
        sessionID: part.sessionID ?? "",
        timestamp: completed,
        text: part.text,
        messageID: part.messageID,
        source: "message.part.updated",
        parent,
      });
    }
  }

  traceGeneration(input: AssistantGenerationInput): void {
    if (this.abortedSessions.has(input.sessionID)) return;
    if (this.tracedGenerationIds.has(input.messageID)) return;
    this.tracedGenerationIds.add(input.messageID);

    const text = this.getAssistantText(input.messageID);
    const output = text ? ({ text } satisfies JsonValue) : undefined;
    const turn = this.getTurn(input.sessionID, input.parentID);
    const toolCalls = this.getAssistantToolCalls(input.messageID);

    if (input.mode !== "compaction" && turn && output) {
      turn.observation.update({ output });
    }

    const totalTokens =
      input.tokens.total ??
      input.tokens.input + input.tokens.output + input.tokens.reasoning;

    const step = this.activeGenerations.get(input.sessionID);
    if (step) {
      step.observation.update({
        model: input.modelID,
        provider: input.providerID,
        usage: {
          inputTokens: input.tokens.input,
          outputTokens: input.tokens.output,
          totalTokens,
        },
        cost: { total: input.cost },
        finishReasons: input.finish ? [input.finish] : undefined,
        output,
        completionEvent: output,
      });
      step.observation.setAttributes({
        "sp.metadata.messageID": input.messageID,
        "sp.metadata.parentID": input.parentID,
        "sp.metadata.providerID": input.providerID,
        "sp.metadata.mode": input.mode,
        "sp.metadata.reasoningTokens": input.tokens.reasoning,
        "sp.metadata.cacheRead": input.tokens.cache.read,
        "sp.metadata.cacheWrite": input.tokens.cache.write,
        ...(input.agent ? { "sp.metadata.agent": input.agent } : {}),
        ...(input.finish ? { "sp.metadata.finish": input.finish } : {}),
        ...(step.model?.variant
          ? { "sp.metadata.variant": step.model.variant }
          : {}),
        ...(step.snapshot ? { "sp.metadata.snapshot": step.snapshot } : {}),
      });
      if (toolCalls.length > 0) {
        recordToolCalls(step.observation, toolCalls);
      }
      this.generationByMessageId.set(input.messageID, step.observation);
      this.flushPendingReasoning(input.messageID, step.observation);
      step.observation.end({ endTime: input.completed });
      this.activeGenerations.delete(input.sessionID);
      return;
    }

    if (!turn) return;

    const generation = this.client.startGeneration({
      name: "opencode.generation",
      parent: turn.observation,
      ...this.sessionAttrs(input.sessionID),
      startTime: input.created,
      model: input.modelID,
      provider: input.providerID,
      operationName: "chat",
      usage: {
        inputTokens: input.tokens.input,
        outputTokens: input.tokens.output,
        totalTokens,
      },
      cost: { total: input.cost },
      output,
      completionEvent: output,
      metadata: {
        messageID: input.messageID,
        parentID: input.parentID,
        agent: input.agent ?? null,
        providerID: input.providerID,
        mode: input.mode,
        finish: input.finish ?? null,
        reasoningTokens: input.tokens.reasoning,
        cacheRead: input.tokens.cache.read,
        cacheWrite: input.tokens.cache.write,
      },
    });
    if (input.finish) {
      generation.update({ finishReasons: [input.finish] });
    }
    if (toolCalls.length > 0) {
      recordToolCalls(generation, toolCalls);
    }
    this.generationParents.set(input.sessionID, generation);
    this.generationByMessageId.set(input.messageID, generation);
    this.flushPendingReasoning(input.messageID, generation);
    generation.end({ endTime: input.completed });
  }

  traceFailedGenerationStep(input: {
    id: string;
    sessionID: string;
    completed: number;
    error: { message: string };
  }): void {
    if (this.tracedGenerationIds.has(input.id)) return;
    this.tracedGenerationIds.add(input.id);

    const step = this.activeGenerations.get(input.sessionID);
    if (step) {
      step.observation.recordException(new Error(input.error.message));
      if (step.agent) {
        step.observation.setAttributes({ "sp.metadata.agent": step.agent });
      }
      step.observation.end({
        endTime: input.completed,
        output: { error: input.error },
      });
      this.activeGenerations.delete(input.sessionID);
      return;
    }

    const turn = this.getTurn(input.sessionID);
    if (!turn) return;

    const generation = this.client.startGeneration({
      name: "opencode.generation.failed",
      parent: turn.observation,
      ...this.sessionAttrs(input.sessionID),
      startTime: input.completed,
      output: { error: input.error },
    });
    generation.recordException(new Error(input.error.message));
    this.generationParents.set(input.sessionID, generation);
    generation.end({ endTime: input.completed });
  }

  traceEvent(input: {
    id: string;
    sessionID: string;
    name: string;
    timestamp: number;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, JsonValue>;
    parent?: Observation | Generation;
  }): void {
    if (this.tracedEventIds.has(input.id)) return;
    this.tracedEventIds.add(input.id);

    const parent =
      input.parent ??
      this.generationParent(input.sessionID) ??
      this.getTurn(input.sessionID)?.observation;

    const event = this.client.startEvent({
      name: input.name,
      ...(parent ? { parent } : {}),
      ...this.sessionAttrs(input.sessionID),
      startTime: input.timestamp,
      input: input.input === undefined ? undefined : asJson(input.input),
      output: input.output === undefined ? undefined : asJson(input.output),
      metadata: input.metadata,
    });
    event.end({ endTime: input.timestamp });
  }

  traceReasoning(input: {
    reasoningID: string;
    sessionID: string;
    timestamp: number;
    text: string;
    messageID?: string;
    source: string;
    parent?: Generation;
  }): void {
    if (!input.text.trim()) return;
    const key = `${input.sessionID}:${input.reasoningID}`;
    if (this.tracedReasoningIds.has(key)) return;
    this.tracedReasoningIds.add(key);

    const parent =
      input.parent ??
      (input.messageID
        ? this.generationByMessageId.get(input.messageID)
        : undefined) ??
      this.generationParent(input.sessionID);

    this.traceEvent({
      id: `reasoning:${key}`,
      sessionID: input.sessionID,
      name: "opencode.generation.reasoning",
      timestamp: input.timestamp,
      output: { text: input.text },
      metadata: {
        reasoningID: input.reasoningID,
        messageID: input.messageID ?? null,
        source: input.source,
      },
      parent,
    });
  }

  traceReasoningPart(part: MessagePart): void {
    const completed = getCompletedReasoningTimestamp(part);
    if (part.type !== "reasoning" || completed === undefined || !part.text) {
      return;
    }
    if (!part.id || !part.sessionID || !part.messageID) return;

    const generation =
      this.generationByMessageId.get(part.messageID) ??
      this.generationParent(part.sessionID);

    if (!generation) {
      const pending =
        this.pendingReasoningByMessageId.get(part.messageID) ??
        new Map<string, MessagePart>();
      pending.set(part.id, part);
      this.pendingReasoningByMessageId.set(part.messageID, pending);
      return;
    }

    this.traceReasoning({
      reasoningID: part.id,
      sessionID: part.sessionID,
      timestamp: completed,
      text: part.text,
      messageID: part.messageID,
      source: "message.part.updated",
      parent: generation,
    });
  }

  /** Fallback when tools arrive before session.next.step.started. */
  private ensureGenerationParent(sessionID: string): void {
    if (
      this.activeGenerations.has(sessionID) ||
      this.generationParents.has(sessionID)
    ) {
      return;
    }
    const turn = this.getTurn(sessionID);
    if (!turn) return;

    const generation = this.client.startGeneration({
      name: "opencode.generation",
      parent: turn.observation,
      ...this.sessionAttrs(sessionID),
      operationName: "chat",
    });
    this.activeGenerations.set(sessionID, {
      observation: generation,
      sessionID,
    });
    this.generationParents.set(sessionID, generation);
  }

  /**
   * Prefer an active/synthetic generation under the agent turn
   * (`agent → generation → tool`). Creates a generation when the turn exists
   * but session.next.step.started never fired.
   */
  private toolParent(sessionID: string) {
    this.ensureGenerationParent(sessionID);
    return this.generationParent(sessionID);
  }

  /**
   * Capture tool observations from message.part.updated when tool.execute.*
   * hooks are missed (or spans from those hooks were dropped on export).
   */
  traceToolPart(part: MessagePart): void {
    if (part.type !== "tool" || !part.tool || !part.sessionID) return;
    const callID = part.callID ?? part.id;
    if (!callID) return;

    const status = part.state?.status;
    if (status === "running" || status === "pending") {
      if (this.activeTools.has(callID)) return;
      this.traceToolStart({
        sessionID: part.sessionID,
        callID,
        tool: part.tool,
        args: part.state?.input,
        started: part.state?.time?.start,
      });
      return;
    }

    if (status !== "completed" && status !== "error") return;

    this.traceToolEnd({
      sessionID: part.sessionID,
      callID,
      tool: part.tool,
      args: part.state?.input,
      title: part.state?.title ?? part.tool,
      output:
        status === "error"
          ? (part.state?.error ?? "error")
          : (part.state?.output ?? ""),
      completed: part.state?.time?.end,
      started: part.state?.time?.start,
      status: status === "error" ? "error" : "ok",
    });
  }

  traceToolStart(input: {
    sessionID: string;
    callID: string;
    tool: string;
    args: unknown;
    started?: number;
  }): void {
    if (this.tracedToolCallIds.has(input.callID)) return;
    const existing = this.activeTools.get(input.callID);
    if (existing) {
      // Same call already open (e.g. message.part.updated running before
      // tool.execute.before). Keep the span; refresh args if we got better ones.
      if (input.args !== undefined) {
        existing.observation.update({ input: asJson(input.args) });
      }
      return;
    }

    const parent = this.toolParent(input.sessionID);
    if (!parent) return;

    const started =
      input.started ??
      this.activeGenerations.get(input.sessionID)?.started ??
      Date.now();

    const tool = this.client.startTool({
      name: input.tool,
      parent,
      ...this.sessionAttrs(input.sessionID),
      startTime: started,
      toolName: input.tool,
      toolCallId: input.callID,
      kind: inferToolKind(input.tool),
      status: "ok",
      input: asJson(input.args),
      metadata: {
        callID: input.callID,
        tool: input.tool,
      },
    });

    this.activeTools.set(input.callID, {
      observation: tool,
      sessionID: input.sessionID,
      tool: input.tool,
      started,
    });
  }

  traceToolEnd(input: {
    sessionID: string;
    callID: string;
    tool: string;
    args: unknown;
    title: string;
    output: string;
    completed?: number;
    started?: number;
    status?: "ok" | "error" | "cancelled";
  }): void {
    if (this.tracedToolCallIds.has(input.callID)) {
      this.activeTools.delete(input.callID);
      return;
    }
    if (!this.activeTools.has(input.callID)) {
      this.traceToolStart({
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        args: input.args,
        started: input.started,
      });
    }
    const active = this.activeTools.get(input.callID);
    if (!active) return;

    const toolStatus = input.status ?? "ok";
    active.observation.setAttributes({
      "sp.metadata.callID": input.callID,
      "sp.metadata.tool": input.tool,
      "sp.tool.status": toolStatus,
    });
    active.observation.end({
      output: { title: input.title, output: input.output },
      endTime: input.completed ?? Date.now(),
      ...(toolStatus === "error"
        ? { statusMessage: input.output || "tool error" }
        : {}),
    });
    this.activeTools.delete(input.callID);
    this.tracedToolCallIds.add(input.callID);
  }

  traceSessionError(input: {
    sessionID: string;
    error?: SessionErrorInfo;
  }): void {
    this.endActiveToolObservations(input.sessionID, input.error);
    this.endActiveGenerationSteps(input.sessionID, input.error);

    if (input.error?.name === "MessageAbortedError") {
      this.abortedSessions.add(input.sessionID);
    }

    const turn = this.getTurn(input.sessionID);
    if (!turn) {
      this.generationParents.delete(input.sessionID);
      return;
    }

    if (input.error) {
      turn.observation.update({
        output: { error: asJson(input.error) },
      });
      if (input.error.name !== "MessageAbortedError") {
        turn.observation.recordException(
          new Error(getSessionErrorMessage(input.error)),
        );
      }
    }
    turn.observation.end();
    if (turn.messageID) this.turnByMessageId.delete(turn.messageID);
    this.latestTurnBySession.delete(input.sessionID);
    this.generationParents.delete(input.sessionID);
  }
}

export function createSoftprobeSessionTracer(
  options: SoftprobeSessionTracerOptions,
): SoftprobeSessionTracer {
  const client = new SoftprobeClient({
    ...options,
    serviceName: options.serviceName ?? "opencode",
    // OpenCode already owns experimental OTEL; keep Softprobe spans on a
    // private provider so we never replace or disable the host tracer.
    registerProvider: options.registerProvider ?? false,
    disableGlobalTracerOnShutdown:
      options.disableGlobalTracerOnShutdown ?? false,
    // Batch + retry: one HTTP POST per span end to thelake (Cloudflare) was
    // timing out and dropping generations/tools while smaller events landed.
    useSimpleProcessor: options.useSimpleProcessor ?? false,
    timeoutMs: options.timeoutMs ?? 30_000,
    headers: {
      // Cloudflare edge has blocked empty/bot-like UAs with 403 on some paths.
      "User-Agent": "SoftprobeOpenCodePlugin/0.1",
      ...(options.headers ?? {}),
    },
  });
  return new SoftprobeSessionTracer(client, { userId: options.userId });
}
