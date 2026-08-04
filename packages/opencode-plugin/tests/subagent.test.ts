import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { SoftprobeClient } from "@softprobe/tracing";
import { describe, expect, it } from "vitest";
import { createHooksFromTracer } from "../src/index.js";
import { SoftprobeSessionTracer } from "../src/softprobe.js";
import type { SessionLookup } from "../src/types.js";

async function createTracer(options: { sessionLookup?: SessionLookup } = {}) {
  const exporter = new InMemorySpanExporter();
  const client = new SoftprobeClient({
    publicKey: "test-key",
    baseUrl: "http://127.0.0.1:8091",
    otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
    serviceName: "opencode",
    environment: "test",
    spanExporter: exporter,
    useSimpleProcessor: true,
  });
  const tracer = new SoftprobeSessionTracer(client, {
    userId: "dev",
    sessionLookup: options.sessionLookup,
  });
  return { tracer, exporter, client };
}

function attr(
  span: ReadableSpan | undefined,
  key: string,
): string | number | boolean | string[] | undefined {
  return span?.attributes[key] as
    | string
    | number
    | boolean
    | string[]
    | undefined;
}

function turnSpan(spans: ReadableSpan[], sessionID: string) {
  return spans.find(
    (s) => s.name === "opencode.turn" && attr(s, "sp.session.id") === sessionID,
  );
}

function taskSpan(spans: ReadableSpan[], callID: string) {
  return spans.find((s) => attr(s, "gen_ai.tool.call.id") === callID);
}

function startTurn(
  tracer: SoftprobeSessionTracer,
  sessionID: string,
  messageID: string,
  text: string,
) {
  tracer.traceUserMessage({
    sessionID,
    messageID,
    agent: "build",
    parts: [{ type: "text", text }],
  });
}

function startTaskCall(
  tracer: SoftprobeSessionTracer,
  sessionID: string,
  callID: string,
  args: Record<string, unknown>,
) {
  tracer.traceToolStart({ sessionID, callID, tool: "task", args });
}

/** Emit the task part update carrying OpenCode's authoritative child link. */
function emitTaskPartMetadata(
  tracer: SoftprobeSessionTracer,
  parentSessionID: string,
  callID: string,
  childSessionID: string,
) {
  tracer.traceToolPart({
    id: `part-${callID}`,
    type: "tool",
    sessionID: parentSessionID,
    messageID: `asst-${callID}`,
    callID,
    tool: "task",
    state: {
      status: "running",
      input: { prompt: "p" },
      metadata: { sessionId: childSessionID, parentSessionId: parentSessionID },
      time: { start: Date.now() },
    },
  });
}

const PARENT = "ses-parent";
const CHILD = "ses-child";

describe("sub-agent nesting", () => {
  it("nests the child turn under the task span via part metadata", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "verify it",
      subagent_type: "verify",
    });
    emitTaskPartMetadata(tracer, PARENT, "call-t1", CHILD);

    await tracer.ensureSessionClassified(CHILD, {
      agent: "verify",
      promptText: "verify it",
    });
    startTurn(tracer, CHILD, "u-child", "verify it");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const parentTurn = turnSpan(raw, PARENT)!;
    const task = taskSpan(raw, "call-t1")!;
    const childTurn = turnSpan(raw, CHILD)!;

    expect(childTurn.parentSpanId).toBe(task.spanContext().spanId);
    expect(childTurn.spanContext().traceId).toBe(
      parentTurn.spanContext().traceId,
    );
    // Sessions keep their own ids; the link is expressed via metadata.
    expect(attr(childTurn, "sp.session.id")).toBe(CHILD);
    expect(attr(childTurn, "sp.metadata.opencode.parentSessionID")).toBe(
      PARENT,
    );
    expect(attr(childTurn, "sp.metadata.opencode.parentTaskCallID")).toBe(
      "call-t1",
    );

    await client.shutdown();
  });

  it("child idle does not disturb the parent session (task output survives)", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "verify it",
      subagent_type: "verify",
    });
    emitTaskPartMetadata(tracer, PARENT, "call-t1", CHILD);
    await tracer.ensureSessionClassified(CHILD, {});
    startTurn(tracer, CHILD, "u-child", "verify it");
    tracer.traceToolStart({
      sessionID: CHILD,
      callID: "call-c1",
      tool: "read",
      args: { filePath: "/tmp/x" },
    });

    // Child session goes idle while the parent task is still running.
    tracer.finalizeSessionTracing(CHILD);
    await client.forceFlush();
    expect(taskSpan(exporter.getFinishedSpans(), "call-t1")).toBeUndefined();

    // The parent task then completes normally — output and child link land.
    tracer.traceToolEnd({
      sessionID: PARENT,
      callID: "call-t1",
      tool: "task",
      args: {},
      title: "task",
      output: "task_id: ses-child\n\n<task_result>\nverified\n</task_result>",
    });
    tracer.finalizeSessionTracing(PARENT);
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const task = taskSpan(raw, "call-t1")!;
    expect(attr(task, "sp.output")).toContain("verified");
    expect(attr(task, "sp.child.session.id")).toBe(CHILD);

    const childTool = raw.find(
      (s) => attr(s, "gen_ai.tool.call.id") === "call-c1",
    )!;
    expect(attr(childTool, "sp.tool.status")).toBe("ok");

    await client.shutdown();
  });

  it("does not recreate a tool span for a late duplicate end", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "go");
    tracer.traceToolStart({
      sessionID: PARENT,
      callID: "call-x",
      tool: "bash",
      args: { command: "ls" },
    });

    // Abort force-ends the tool span…
    tracer.traceSessionError({
      sessionID: PARENT,
      error: { name: "MessageAbortedError", message: "aborted" },
    });
    // …then the completed part arrives late.
    tracer.traceToolPart({
      id: "part-x",
      type: "tool",
      sessionID: PARENT,
      messageID: "asst-x",
      callID: "call-x",
      tool: "bash",
      state: {
        status: "completed",
        output: "late",
        time: { start: Date.now(), end: Date.now() },
      },
    });

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const tools = exporter
      .getFinishedSpans()
      .filter((s) => attr(s, "gen_ai.tool.call.id") === "call-x");
    expect(tools).toHaveLength(1);
    expect(attr(tools[0], "sp.tool.status")).toBe("cancelled");

    await client.shutdown();
  });

  it("re-binds a resumed child session to the new task call", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "verify it",
      subagent_type: "verify",
    });
    emitTaskPartMetadata(tracer, PARENT, "call-t1", CHILD);
    startTurn(tracer, CHILD, "u-child-1", "verify it");
    tracer.traceToolEnd({
      sessionID: PARENT,
      callID: "call-t1",
      tool: "task",
      args: {},
      title: "task",
      output: "done",
    });

    // Resume: a new task call names the old child session via task_id and
    // publishes fresh part metadata.
    startTaskCall(tracer, PARENT, "call-t2", {
      prompt: "keep going",
      subagent_type: "verify",
      task_id: CHILD,
    });
    emitTaskPartMetadata(tracer, PARENT, "call-t2", CHILD);
    startTurn(tracer, CHILD, "u-child-2", "keep going");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const resumed = raw.find(
      (s) =>
        s.name === "opencode.turn" &&
        attr(s, "sp.session.id") === CHILD &&
        String(attr(s, "sp.input")).includes("keep going"),
    )!;
    const second = taskSpan(raw, "call-t2")!;
    expect(resumed.parentSpanId).toBe(second.spanContext().spanId);
    expect(attr(taskSpan(raw, "call-t1"), "sp.child.session.id")).toBe(CHILD);
    expect(attr(second, "sp.child.session.id")).toBe(CHILD);

    await client.shutdown();
  });

  it("falls back to parentID + unique task call without part metadata", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "legacy",
      subagent_type: "verify",
    });

    // Older OpenCode: only session.created carries the link.
    tracer.registerSessionInfo(CHILD, PARENT);
    await tracer.ensureSessionClassified(CHILD, {
      agent: "verify",
      promptText: "legacy",
    });
    startTurn(tracer, CHILD, "u-child", "legacy");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    expect(turnSpan(raw, CHILD)!.parentSpanId).toBe(
      taskSpan(raw, "call-t1")!.spanContext().spanId,
    );

    await client.shutdown();
  });

  it("resolves an unknown session via the lazy client lookup", async () => {
    const lookup: SessionLookup = async (sessionID) =>
      sessionID === CHILD ? PARENT : undefined;
    const { tracer, exporter, client } = await createTracer({
      sessionLookup: lookup,
    });
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "lazy",
      subagent_type: "verify",
    });

    await tracer.ensureSessionClassified(CHILD, { promptText: "lazy" });
    startTurn(tracer, CHILD, "u-child", "lazy");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    expect(turnSpan(raw, CHILD)!.parentSpanId).toBe(
      taskSpan(raw, "call-t1")!.spanContext().spanId,
    );

    await client.shutdown();
  });

  it("never guesses among ambiguous parallel task calls", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "same",
      subagent_type: "verify",
    });
    startTaskCall(tracer, PARENT, "call-t2", {
      prompt: "same",
      subagent_type: "verify",
    });

    tracer.registerSessionInfo(CHILD, PARENT);
    await tracer.ensureSessionClassified(CHILD, {
      agent: "verify",
      promptText: "same",
    });
    startTurn(tracer, CHILD, "u-child", "same");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const childTurn = turnSpan(raw, CHILD)!;
    // Ambiguous: falls back to the parent turn, never to a guessed task span.
    expect(childTurn.parentSpanId).toBe(
      turnSpan(raw, PARENT)!.spanContext().spanId,
    );
    expect(childTurn.parentSpanId).not.toBe(
      taskSpan(raw, "call-t1")!.spanContext().spanId,
    );
    expect(childTurn.parentSpanId).not.toBe(
      taskSpan(raw, "call-t2")!.spanContext().spanId,
    );

    await client.shutdown();
  });

  it("attaches late children under the already-ended task span", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "fast",
      subagent_type: "verify",
    });
    // Fast-failing sub-agent: the task span ends before the child turn starts.
    tracer.traceToolEnd({
      sessionID: PARENT,
      callID: "call-t1",
      tool: "task",
      args: {},
      title: "task",
      output: "failed fast",
      status: "error",
    });
    emitTaskPartMetadata(tracer, PARENT, "call-t1", CHILD);
    await tracer.ensureSessionClassified(CHILD, {});
    startTurn(tracer, CHILD, "u-child", "fast");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    expect(turnSpan(raw, CHILD)!.parentSpanId).toBe(
      taskSpan(raw, "call-t1")!.spanContext().spanId,
    );

    await client.shutdown();
  });

  it("nests grandchildren along the same trace", async () => {
    const { tracer, exporter, client } = await createTracer();
    const GRANDCHILD = "ses-grandchild";
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "verify it",
      subagent_type: "verify",
    });
    emitTaskPartMetadata(tracer, PARENT, "call-t1", CHILD);
    startTurn(tracer, CHILD, "u-child", "verify it");

    // The child dispatches its own sub-agent.
    startTaskCall(tracer, CHILD, "call-t2", {
      prompt: "deeper",
      subagent_type: "explore",
    });
    emitTaskPartMetadata(tracer, CHILD, "call-t2", GRANDCHILD);
    startTurn(tracer, GRANDCHILD, "u-grandchild", "deeper");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const grandchildTurn = turnSpan(raw, GRANDCHILD)!;
    expect(grandchildTurn.parentSpanId).toBe(
      taskSpan(raw, "call-t2")!.spanContext().spanId,
    );
    expect(grandchildTurn.spanContext().traceId).toBe(
      turnSpan(raw, PARENT)!.spanContext().traceId,
    );

    await client.shutdown();
  });
});

describe("sub-agent nesting via OpenCode hooks", () => {
  it("wires session events, chat hooks, and scoped idle end-to-end", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      serviceName: "opencode",
      environment: "test",
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });
    const tracer = new SoftprobeSessionTracer(client);
    const hooks = createHooksFromTracer(tracer);

    await hooks["chat.message"]?.(
      { sessionID: PARENT, messageID: "u-parent", agent: "build" } as never,
      { parts: [{ type: "text", text: "do the thing" }] } as never,
    );
    await hooks["tool.execute.before"]?.(
      { sessionID: PARENT, callID: "call-t1", tool: "task" } as never,
      { args: { prompt: "verify it", subagent_type: "verify" } } as never,
    );
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: CHILD, parentID: PARENT } },
      },
    } as never);
    await hooks["chat.message"]?.(
      { sessionID: CHILD, messageID: "u-child", agent: "verify" } as never,
      { parts: [{ type: "text", text: "verify it" }] } as never,
    );

    // Child goes idle via the modern session.status event.
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: CHILD, status: { type: "idle" } },
      },
    } as never);

    // Parent task is still running and completes with its output intact.
    await hooks["tool.execute.after"]?.(
      {
        sessionID: PARENT,
        callID: "call-t1",
        tool: "task",
        args: { prompt: "verify it" },
      } as never,
      { title: "task", output: "<task_result>\nverified\n</task_result>" } as never,
    );
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: PARENT } },
    } as never);

    await client.forceFlush();
    const raw = exporter.getFinishedSpans();
    expect(turnSpan(raw, CHILD)!.parentSpanId).toBe(
      taskSpan(raw, "call-t1")!.spanContext().spanId,
    );
    expect(attr(taskSpan(raw, "call-t1"), "sp.output")).toContain("verified");

    await hooks.dispose?.();
  });
});
