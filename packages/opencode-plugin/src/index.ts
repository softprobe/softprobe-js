import type { Hooks, Plugin } from "@opencode-ai/plugin";
import {
  loadSoftprobeCredentials,
  MissingSoftprobeCredentialsError,
} from "./config.js";
import {
  createSoftprobeSessionTracer,
  SoftprobeSessionTracer,
} from "./softprobe.js";
import type { MessagePart, SessionNextEvent } from "./types.js";

type OpencodeEvent =
  | Parameters<NonNullable<Hooks["event"]>>[0]["event"]
  | SessionNextEvent;

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

async function handleEvent(
  tracer: SoftprobeSessionTracer,
  event: OpencodeEvent,
  shutdown?: () => Promise<void>,
): Promise<void> {
  if (event.type === "session.idle") {
    log("info", "Flushing spans");
    tracer.finalizeSessionTracing();
    await tracer.forceFlush();
  }

  if (event.type === "server.instance.disposed") {
    tracer.finalizeSessionTracing();
    if (shutdown) await shutdown();
  }

  if (event.type === "session.error" && "properties" in event) {
    const props = event.properties as {
      sessionID?: string;
      error?: { name: string; message?: string };
    };
    if (props.sessionID) {
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
}

type AssistantTokens = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

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
          await handleEvent(tracer, event as OpencodeEvent, shutdownOnce);
        } catch (error) {
          // forceFlush often rejects with [Error] when thelake is slow;
          // spans may already have been accepted via BatchSpanProcessor.
          // Log and continue so session lifecycle is not blocked on OTLP.
          if (
            event.type === "session.idle" &&
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
      safeRun("chat.message", () => {
        tracer.traceUserMessage({
          sessionID: input.sessionID,
          messageID: input.messageID,
          agent: input.agent,
          model: input.model,
          parts: output.parts as MessagePart[],
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

export const SoftprobePlugin: Plugin = async () => {
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
export {
  loadSoftprobeCredentials,
  MissingSoftprobeCredentialsError,
  defaultConfigDir,
  defaultConfigPath,
  type SoftprobePluginCredentials,
} from "./config.js";
export { inferToolKind } from "./tool-kind.js";
