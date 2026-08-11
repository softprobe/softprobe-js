import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { SoftprobeClient } from "@softprobe/tracing";
import { describe, expect, it, vi } from "vitest";
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

describe("binding and lifecycle edge cases", () => {
  it("never substitutes a sibling task span for a bound call whose span was never created", async () => {
    const { tracer, exporter, client } = await createTracer();
    // Task A is dispatched before PARENT has a turn (plugin loaded mid-session,
    // or the turn was cleared by a session error): the call is registered but
    // no span can be created for it.
    startTaskCall(tracer, PARENT, "call-a", {
      prompt: "a",
      subagent_type: "verify",
    });
    emitTaskPartMetadata(tracer, PARENT, "call-a", CHILD);

    // A turn opens and an UNRELATED task B runs — this one does get a span.
    startTurn(tracer, PARENT, "u-parent", "go");
    startTaskCall(tracer, PARENT, "call-b", {
      prompt: "b",
      subagent_type: "explore",
    });

    await tracer.ensureSessionClassified(CHILD, {});
    startTurn(tracer, CHILD, "u-child", "a");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const childTurn = turnSpan(raw, CHILD)!;
    // Task A's span does not exist; task B is somebody else's sub-agent.
    // Fall back to the parent turn rather than mis-parenting under B.
    expect(childTurn.parentSpanId).not.toBe(
      taskSpan(raw, "call-b")!.spanContext().spanId,
    );
    expect(childTurn.parentSpanId).toBe(
      turnSpan(raw, PARENT)!.spanContext().spanId,
    );

    await client.shutdown();
  });

  it("keeps dedup keys across a global finalize (dispose, or an idle with no sessionID)", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-1", "go");
    tracer.traceToolStart({
      sessionID: PARENT,
      callID: "call-l1",
      tool: "bash",
      args: { command: "ls" },
    });
    // Legacy host: idle carries no sessionID, so everything is finalized.
    tracer.finalizeSessionTracing();
    startTurn(tracer, PARENT, "u-2", "again");
    // The completed part arrives after the global finalize.
    tracer.traceToolPart({
      id: "part-l1",
      type: "tool",
      sessionID: PARENT,
      messageID: "asst-l1",
      callID: "call-l1",
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
      .filter((s) => attr(s, "gen_ai.tool.call.id") === "call-l1");
    expect(tools).toHaveLength(1);

    await client.shutdown();
  });

  it("omits sp.child.session.id when the task span ends before the child link lands", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "go");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "fast",
      subagent_type: "verify",
    });
    tracer.traceToolEnd({
      sessionID: PARENT,
      callID: "call-t1",
      tool: "task",
      args: {},
      title: "task",
      output: "failed fast",
      status: "error",
    });
    // The link arrives after the span is closed — OTEL drops attributes set
    // on an ended span, so the forward edge is lost by construction.
    emitTaskPartMetadata(tracer, PARENT, "call-t1", CHILD);
    startTurn(tracer, CHILD, "u-child", "fast");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    expect(attr(taskSpan(raw, "call-t1"), "sp.child.session.id")).toBeUndefined();
    // The reverse edge still records the relationship.
    expect(attr(turnSpan(raw, CHILD), "sp.metadata.opencode.parentTaskCallID")).toBe(
      "call-t1",
    );

    await client.shutdown();
  });

  it("resume disorder: task_id binds at tool start, before the child message", async () => {
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

    // Resume: the new task call names the child via task_id. The child's
    // message arrives BEFORE the call's part metadata (bus lag) — the
    // task_id binding made at tool start must win over the stale call-t1
    // binding.
    startTaskCall(tracer, PARENT, "call-t2", {
      prompt: "keep going",
      subagent_type: "verify",
      task_id: CHILD,
    });
    await tracer.ensureSessionClassified(CHILD, {
      agent: "verify",
      promptText: "keep going",
    });
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
    expect(resumed.parentSpanId).toBe(
      taskSpan(raw, "call-t2")!.spanContext().spanId,
    );

    await client.shutdown();
  });

  it("does not recreate a ghost span for a part arriving after scoped idle + new turn", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-1", "go");
    tracer.traceToolStart({
      sessionID: PARENT,
      callID: "call-g1",
      tool: "bash",
      args: { command: "ls" },
    });

    // Idle force-ends the tool and clears the session's payload caches…
    tracer.finalizeSessionTracing(PARENT);
    // …a new turn starts…
    startTurn(tracer, PARENT, "u-2", "again");
    // …and only then the completed part arrives late.
    tracer.traceToolPart({
      id: "part-g1",
      type: "tool",
      sessionID: PARENT,
      messageID: "asst-g1",
      callID: "call-g1",
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
      .filter((s) => attr(s, "gen_ai.tool.call.id") === "call-g1");
    expect(tools).toHaveLength(1);

    await client.shutdown();
  });

  it("binds via part metadata without parentSessionId (falls back to the part's session)", async () => {
    const { tracer, exporter, client } = await createTracer();
    startTurn(tracer, PARENT, "u-parent", "do the thing");
    startTaskCall(tracer, PARENT, "call-t1", {
      prompt: "verify it",
      subagent_type: "verify",
    });
    tracer.traceToolPart({
      id: "part-t1",
      type: "tool",
      sessionID: PARENT,
      messageID: "asst-t1",
      callID: "call-t1",
      tool: "task",
      state: {
        status: "running",
        metadata: { sessionId: CHILD },
        time: { start: Date.now() },
      },
    });
    startTurn(tracer, CHILD, "u-child", "verify it");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    expect(turnSpan(raw, CHILD)!.parentSpanId).toBe(
      taskSpan(raw, "call-t1")!.spanContext().spanId,
    );

    await client.shutdown();
  });

  it("classifies as root when the lookup fails", async () => {
    const { tracer, exporter, client } = await createTracer({
      sessionLookup: async () => {
        throw new Error("lookup boom");
      },
    });
    await tracer.ensureSessionClassified(CHILD, { agent: "verify" });
    startTurn(tracer, CHILD, "u-child", "verify it");

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const childTurn = turnSpan(raw, CHILD)!;
    expect(childTurn.parentSpanId).toBeUndefined();

    await client.shutdown();
  });
});

describe("session lifecycle via OpenCode hooks", () => {
  async function createHookedTracer() {
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
    return { exporter, client, tracer, hooks };
  }

  it("coalesces duplicate idle events but never swallows a fresh idle", async () => {
    const { exporter, client, hooks } = await createHookedTracer();
    const flushSpy = vi.spyOn(client, "forceFlush");

    // Turn 1 ends: session.status idle + session.idle are one transition.
    await hooks["chat.message"]?.(
      { sessionID: PARENT, messageID: "u-1", agent: "build" } as never,
      { parts: [{ type: "text", text: "one" }] } as never,
    );
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: PARENT, status: { type: "idle" } },
      },
    } as never);
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: PARENT } },
    } as never);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    // Turn 2 starts and finishes quickly — its idle is a fresh transition
    // and must be processed despite falling inside the coalescing window.
    await hooks["chat.message"]?.(
      { sessionID: PARENT, messageID: "u-2", agent: "build" } as never,
      { parts: [{ type: "text", text: "two" }] } as never,
    );
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: PARENT } },
    } as never);
    expect(flushSpy).toHaveBeenCalledTimes(2);

    await client.forceFlush();
    const turns = exporter
      .getFinishedSpans()
      .filter(
        (s) => s.name === "opencode.turn" && attr(s, "sp.session.id") === PARENT,
      );
    expect(turns).toHaveLength(2);

    await hooks.dispose?.();
  });

  it("busy status resets the idle coalescing mark", async () => {
    const { client, hooks } = await createHookedTracer();
    const flushSpy = vi.spyOn(client, "forceFlush");

    await hooks["chat.message"]?.(
      { sessionID: PARENT, messageID: "u-1", agent: "build" } as never,
      { parts: [{ type: "text", text: "one" }] } as never,
    );
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: PARENT } },
    } as never);
    // Activity resumes without a chat.message (e.g. queued assistant work).
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: PARENT, status: { type: "busy" } },
      },
    } as never);
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: PARENT } },
    } as never);

    expect(flushSpy).toHaveBeenCalledTimes(2);
    await hooks.dispose?.();
  });

  it("a new generation step resets the idle coalescing mark", async () => {
    const { client, hooks } = await createHookedTracer();
    const flushSpy = vi.spyOn(client, "forceFlush");

    await hooks["chat.message"]?.(
      { sessionID: PARENT, messageID: "u-1", agent: "build" } as never,
      { parts: [{ type: "text", text: "one" }] } as never,
    );
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: PARENT } },
    } as never);
    // Work resumes without a chat.message and without a busy status — only
    // session.next.step.started marks the new activity.
    await hooks.event?.({
      event: {
        id: "evt-step",
        type: "session.next.step.started",
        properties: {
          sessionID: PARENT,
          timestamp: Date.now(),
          agent: "build",
          model: { providerID: "anthropic", id: "claude" },
        },
      },
    } as never);
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: PARENT } },
    } as never);

    expect(flushSpy).toHaveBeenCalledTimes(2);
    await hooks.dispose?.();
  });

  it("session.deleted finalizes the session's in-flight spans", async () => {
    const { exporter, client, hooks } = await createHookedTracer();

    await hooks["chat.message"]?.(
      { sessionID: PARENT, messageID: "u-1", agent: "build" } as never,
      { parts: [{ type: "text", text: "one" }] } as never,
    );
    await hooks["tool.execute.before"]?.(
      { sessionID: PARENT, callID: "call-d1", tool: "bash" } as never,
      { args: { command: "ls" } } as never,
    );
    await hooks.event?.({
      event: { type: "session.deleted", properties: { info: { id: PARENT } } },
    } as never);

    await client.forceFlush();
    const raw = exporter.getFinishedSpans();
    // Both the turn and the in-flight tool span were ended, not leaked.
    expect(turnSpan(raw, PARENT)).toBeDefined();
    const tool = raw.find((s) => attr(s, "gen_ai.tool.call.id") === "call-d1");
    expect(tool).toBeDefined();

    await hooks.dispose?.();
  });
});
