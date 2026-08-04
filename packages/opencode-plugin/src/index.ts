import type { Hooks, Plugin } from "@opencode-ai/plugin";
import {
  loadSoftprobeCredentials,
  MissingSoftprobeCredentialsError,
} from "./config.js";
import {
  createSoftprobeSessionTracer,
  SoftprobeSessionTracer,
} from "./softprobe.js";
import { BoundedMap } from "./bounded.js";
import type {
  MessagePart,
  SessionLifecycleEvent,
  SessionLookup,
  SessionNextEvent,
} from "./types.js";

type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent
  | SessionLifecycleEvent;

/** Properties of a lifecycle event, by event type. */
type LifecycleProps<T extends SessionLifecycleEvent["type"]> = Extract<
  SessionLifecycleEvent,
  { type: T }
>["properties"];

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[softprobe-opencode] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

function formatHookError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (Array.isArray(error)) {
    return error.map((item) => formatHookError(item)).join("; ") || "[]";
  }
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}" && json !== "[{}]") return json;
  } catch {
    // fall through
  }
  return String(error);
}

function createShutdownOnce(tracer: SoftprobeSessionTracer) {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    if (!shutdownPromise) {
      shutdownPromise = tracer.shutdown().catch((error) => {
        log("error", `shutdown failed: ${formatHookError(error)}`);
      });
    }
    return shutdownPromise;
  };
}

const SESSION_LOOKUP_TIMEOUT_MS = 1500;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build a lazy parent-session lookup from the OpenCode plugin client.
 * Returns undefined when the client or its session API is unavailable.
 */
function createSessionLookup(client: unknown): SessionLookup | undefined {
  const sessionApi = (
    client as
      | {
          session?: {
            get?: (args: { path: { id: string } }) => Promise<unknown>;
          };
        }
      | undefined
  )?.session;
  if (typeof sessionApi?.get !== "function") return undefined;
  const get = sessionApi.get;
  return async (sessionID: string) => {
    const response = await withTimeout(
      get.call(sessionApi, { path: { id: sessionID } }),
      SESSION_LOOKUP_TIMEOUT_MS,
    );
    if (!response || typeof response !== "object") return undefined;
    // hey-api clients wrap payloads in { data }; older shapes vary.
    const record = response as Record<string, unknown>;
    const data = (record.data ?? record) as Record<string, unknown>;
    const info = (data.info ?? data) as Record<string, unknown>;
    return typeof info.parentID === "string" ? info.parentID : undefined;
  };
}

/** The first text part holds the raw prompt (OpenCode appends parts for @-mentions). */
function firstTextPart(parts: MessagePart[] | undefined): string | undefined {
  const first = parts?.find((part) => part.type === "text");
  return typeof first?.text === "string" ? first.text : undefined;
}

function safeRun(hookName: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      log("error", `hook "${hookName}" failed: ${formatHookError(error)}`);
    });
}

/** Build OpenCode hooks from an existing tracer (used by the plugin and tests). */
export function createHooksFromTracer(tracer: SoftprobeSessionTracer): Hooks {
  const shutdownOnce = createShutdownOnce(tracer);

  // session.status {type:"idle"} and the deprecated session.idle fire
  // back-to-back for the same transition — coalesce per session. The mark is
  // reset on any new activity (busy status, a new user message, a new
  // generation step) so a genuinely new idle is never swallowed.
  const IDLE_COALESCE_MS = 2000;
  const IDLE_MARK_CAP = 500;
  const idleHandledAt = new BoundedMap<number>(IDLE_MARK_CAP);

  const handleSessionIdle = async (sessionID?: string): Promise<void> => {
    if (sessionID) {
      const now = Date.now();
      const last = idleHandledAt.get(sessionID);
      if (last !== undefined && now - last < IDLE_COALESCE_MS) return;
      idleHandledAt.set(sessionID, now);
    }
    log("info", "Flushing spans");
    // Scoped finalize: a sub-agent session going idle must not end the
    // parent session's in-flight spans. Without a sessionID (old hosts),
    // fall back to finalizing everything.
    tracer.finalizeSessionTracing(sessionID);
    await tracer.forceFlush();
  };

  const handleEvent = async (event: OpencodeEvent): Promise<void> => {
    if (event.type === "session.idle") {
      const props = ("properties" in event
        ? event.properties
        : undefined) as LifecycleProps<"session.idle">;
      await handleSessionIdle(props?.sessionID);
    }

    if (event.type === "session.status" && "properties" in event) {
      const props = event.properties as LifecycleProps<"session.status">;
      if (props?.status?.type === "idle") {
        await handleSessionIdle(props.sessionID);
      } else if (props?.sessionID && props.status?.type) {
        // New activity: the next idle is a fresh transition, not a duplicate.
        idleHandledAt.delete(props.sessionID);
      }
    }

    if (
      (event.type === "session.created" || event.type === "session.updated") &&
      "properties" in event
    ) {
      const info = (event.properties as LifecycleProps<"session.created">)
        ?.info;
      // Session genealogy: task-tool child sessions carry parentID here.
      if (info?.id) tracer.registerSessionInfo(info.id, info.parentID);
    }

    if (event.type === "session.deleted" && "properties" in event) {
      const info = (event.properties as LifecycleProps<"session.deleted">)
        ?.info;
      if (info?.id) {
        // End the deleted session's in-flight spans before dropping its
        // relationship data, so nothing leaks open until dispose.
        tracer.finalizeSessionTracing(info.id);
        tracer.evictSession(info.id);
        idleHandledAt.delete(info.id);
      }
    }

    if (event.type === "server.instance.disposed") {
      tracer.finalizeSessionTracing();
      await shutdownOnce();
    }

    if (event.type === "session.error" && "properties" in event) {
      const props = event.properties as LifecycleProps<"session.error">;
      if (props?.sessionID) {
        tracer.traceSessionError({
          sessionID: props.sessionID,
          error: props.error,
        });
      }
    }

    if (event.type === "message.part.updated" && "properties" in event) {
      const part = (event.properties as { part: MessagePart }).part;
      tracer.rememberAssistantPart(part);
      tracer.traceReasoningPart(part);
      tracer.traceToolPart(part);
    }

    if (event.type === "session.next.step.started") {
      // Activity without a chat.message (queued work, sub-agent turns): the
      // next idle is a fresh transition, not a duplicate of the last one.
      // If a step.started were ever delivered *between* the paired idle
      // events, this defeats their coalescing — costing one extra forceFlush,
      // not a span, since the first finalize already cleared the turn.
      idleHandledAt.delete(event.properties.sessionID);
      tracer.startActiveGenerationStep({
        sessionID: event.properties.sessionID,
        agent: event.properties.agent,
        model: event.properties.model,
        started: event.properties.timestamp,
        snapshot: event.properties.snapshot,
      });
    }

    if (event.type === "session.next.step.failed") {
      tracer.traceFailedGenerationStep({
        id: event.id,
        sessionID: event.properties.sessionID,
        completed: event.properties.timestamp,
        error: event.properties.error,
      });
    }

    if (event.type === "session.next.retried") {
      tracer.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.retry",
        timestamp: event.properties.timestamp,
        output: event.properties.error as never,
        metadata: { attempt: event.properties.attempt },
      });
    }

    if (event.type === "session.next.reasoning.ended") {
      tracer.traceReasoning({
        reasoningID: event.properties.reasoningID,
        sessionID: event.properties.sessionID,
        timestamp: event.properties.timestamp,
        text: event.properties.text,
        messageID: event.properties.assistantMessageID,
        source: "session.next.reasoning.ended",
      });
    }

    if (event.type === "session.next.compaction.ended") {
      tracer.traceEvent({
        id: event.id,
        sessionID: event.properties.sessionID,
        name: "opencode.generation.compaction",
        timestamp: event.properties.timestamp,
        output: { text: event.properties.text },
        metadata: {
          include: event.properties.include ?? null,
        },
      });
    }

    if (event.type === "message.updated" && "properties" in event) {
      const message = (
        event.properties as {
          info: {
            role: string;
            id: string;
            sessionID: string;
            parentID: string;
            modelID: string;
            providerID: string;
            mode: string;
            finish?: string;
            cost: number;
            tokens: AssistantTokens;
            time: { created: number; completed?: number };
          };
        }
      ).info;

      if (message.role !== "assistant" || !message.time.completed) {
        return;
      }

      tracer.traceGeneration({
        sessionID: message.sessionID,
        messageID: message.id,
        parentID: message.parentID,
        modelID: message.modelID,
        providerID: message.providerID,
        agent: message.mode,
        mode: message.mode,
        created: message.time.created,
        completed: message.time.completed,
        finish: message.finish,
        cost: message.cost,
        tokens: message.tokens,
      });
    }
  };

  return {
    dispose: () =>
      safeRun("dispose", async () => {
        tracer.finalizeSessionTracing();
        await shutdownOnce();
      }),

    config: (config) =>
      safeRun("config", () => {
        if (!config.experimental?.openTelemetry) {
          log(
            "warn",
            "[Tracing disabled] Enable `experimental.openTelemetry` in opencode.json to use the Softprobe plugin",
          );
        }
      }),

    event: ({ event }) =>
      safeRun("event", async () => {
        try {
          await handleEvent(event as OpencodeEvent);
        } catch (error) {
          // forceFlush often rejects with [Error] when thelake is slow;
          // spans may already have been accepted via BatchSpanProcessor.
          // Log and continue so session lifecycle is not blocked on OTLP.
          if (
            (event.type === "session.idle" || event.type === "session.status") &&
            (Array.isArray(error) ||
              (error instanceof Error && /timed out/i.test(error.message)))
          ) {
            log("warn", `flush after session.idle: ${formatHookError(error)}`);
            return;
          }
          throw error;
        }
      }),

    "chat.message": (input, output) =>
      safeRun("chat.message", async () => {
        const parts = output.parts as MessagePart[];
        // A new turn is fresh activity — the next idle is not a duplicate.
        idleHandledAt.delete(input.sessionID);
        // Classify (root vs sub-agent child) before the turn span is created;
        // spans cannot be re-parented afterwards. Classification is a pure
        // enhancement: its failure must never cost the turn itself.
        try {
          await tracer.ensureSessionClassified(input.sessionID, {
            agent: input.agent,
            promptText: firstTextPart(parts),
          });
        } catch (error) {
          log("warn", `session classification failed: ${formatHookError(error)}`);
        }
        tracer.traceUserMessage({
          sessionID: input.sessionID,
          messageID: input.messageID,
          agent: input.agent,
          model: input.model,
          parts,
        });
      }),

    "tool.execute.before": (input, output) =>
      safeRun("tool.execute.before", () => {
        tracer.traceToolStart({
          sessionID: input.sessionID,
          callID: input.callID,
          tool: input.tool,
          args: output.args,
        });
      }),

    "tool.execute.after": (input, output) =>
      safeRun("tool.execute.after", () => {
        tracer.traceToolEnd({
          sessionID: input.sessionID,
          callID: input.callID,
          tool: input.tool,
          args: input.args,
          title: output.title,
          output: output.output,
        });
      }),
  };
}

type AssistantTokens = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export const SoftprobePlugin: Plugin = async (input) => {
  let tracer: SoftprobeSessionTracer | undefined;

  try {
    const credentials = await loadSoftprobeCredentials();
    tracer = createSoftprobeSessionTracer({
      publicKey: credentials.publicKey,
      baseUrl: credentials.baseUrl,
      otlpEndpoint: credentials.otlpEndpoint,
      environment: credentials.environment,
      userId: credentials.userId,
      serviceName: credentials.serviceName ?? "opencode",
      sessionLookup: createSessionLookup(input?.client),
    });
    log("info", `OTLP tracing initialized → ${credentials.otlpEndpoint}`);
  } catch (error) {
    if (error instanceof MissingSoftprobeCredentialsError) {
      log("warn", `[Tracing disabled] ${error.message}`);
      return {};
    }
    throw error;
  }

  return createHooksFromTracer(tracer);
};

/**
 * OpenCode V1 plugin shape (`{ id, server }`).
 * Required so file:// installs do not fall through to legacy export scanning,
 * which would invoke every exported function/class (including Error subclasses).
 */
export default {
  id: "softprobe-opencode",
  server: SoftprobePlugin,
};

export {
  SoftprobeSessionTracer,
  createSoftprobeSessionTracer,
} from "./softprobe.js";
export { SessionGraph, parseTaskCallArgs } from "./session-graph.js";
export type { TaskBinding, TaskCallArgs } from "./session-graph.js";
export type { SessionLookup } from "./types.js";
export {
  loadSoftprobeCredentials,
  MissingSoftprobeCredentialsError,
  defaultConfigDir,
  defaultConfigPath,
  type SoftprobePluginCredentials,
} from "./config.js";
export { inferToolKind } from "./tool-kind.js";
