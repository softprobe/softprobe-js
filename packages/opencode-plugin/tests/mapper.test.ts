import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { SoftprobeClient, normalizeReadableSpans } from "@softprobe/tracing";
import { afterEach, describe, expect, it } from "vitest";
import { SoftprobeSessionTracer } from "../src/softprobe.js";

async function createTracer() {
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
  const tracer = new SoftprobeSessionTracer(client, { userId: "dev" });
  return { tracer, exporter, client };
}

function attr(
  span: ReadableSpan,
  key: string,
): string | number | boolean | string[] | undefined {
  return span.attributes[key] as
    | string
    | number
    | boolean
    | string[]
    | undefined;
}

afterEach(() => {
  // clients shut down inside tests
});

describe("SoftprobeSessionTracer core path", () => {
  it("emits agent → generation → tool topology with full payloads", async () => {
    const { tracer, exporter, client } = await createTracer();
    const sessionID = "sess-opencode-1";
    const t0 = Date.parse("2024-07-19T12:00:00.000Z");

    tracer.traceUserMessage({
      sessionID,
      messageID: "msg-user-1",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-4.1" },
      parts: [{ type: "text", text: "fix the bug" }],
    });

    tracer.startActiveGenerationStep({
      sessionID,
      agent: "build",
      model: { providerID: "openai", id: "gpt-4.1" },
      started: t0 + 10,
    });

    tracer.traceToolStart({
      sessionID,
      callID: "call-1",
      tool: "bash",
      args: { command: "ls" },
    });
    tracer.traceToolEnd({
      sessionID,
      callID: "call-1",
      tool: "bash",
      args: { command: "ls" },
      title: "ls",
      output: "README.md",
    });

    tracer.rememberAssistantPart({
      id: "part-text",
      type: "text",
      messageID: "msg-asst-1",
      text: "done",
    });
    tracer.rememberAssistantPart({
      id: "call-1",
      type: "tool",
      messageID: "msg-asst-1",
      tool: "bash",
    });

    tracer.traceGeneration({
      sessionID,
      messageID: "msg-asst-1",
      parentID: "msg-user-1",
      modelID: "gpt-4.1",
      providerID: "openai",
      mode: "build",
      created: t0 + 10,
      completed: t0 + 5000,
      finish: "stop",
      cost: 0.01,
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const raw = exporter.getFinishedSpans();
    const normalized = normalizeReadableSpans(raw);
    const agents = normalized.filter((s) => s.observation_type === "agent");
    const generations = normalized.filter(
      (s) => s.observation_type === "generation",
    );
    const tools = normalized.filter((s) => s.observation_type === "tool");

    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(generations.length).toBeGreaterThanOrEqual(1);
    expect(tools.length).toBe(1);

    const tool = raw.find((s) => attr(s, "sp.observation.type") === "tool")!;
    expect(attr(tool, "gen_ai.tool.name")).toBe("bash");
    expect(attr(tool, "gen_ai.tool.call.id")).toBe("call-1");
    expect(attr(tool, "sp.tool.kind")).toBe("shell");
    expect(attr(tool, "sp.session.id")).toBe(sessionID);
    expect(attr(tool, "sp.input")).toContain("ls");
    expect(attr(tool, "sp.output")).toContain("README");
    expect(tool.startTime[0]).toBe(Math.floor((t0 + 10) / 1000));

    const generation = raw.find(
      (s) =>
        attr(s, "sp.observation.type") === "generation" &&
        s.name === "opencode.generation",
    )!;
    expect(attr(generation, "gen_ai.request.model")).toBe("gpt-4.1");
    expect(attr(generation, "gen_ai.usage.input_tokens")).toBe(10);
    expect(generation.startTime[0]).toBe(Math.floor((t0 + 10) / 1000));
    expect(generation.endTime[0]).toBe(Math.floor((t0 + 5000) / 1000));
    expect(attr(generation, "sp.tool.call_ids")).toEqual(["call-1"]);
    expect(attr(generation, "sp.output")).toContain("done");
    expect(
      generation.events.some((e) => e.name === "gen_ai.content.completion"),
    ).toBe(true);

    const agent = raw.find((s) => attr(s, "sp.observation.type") === "agent")!;
    expect(attr(agent, "sp.input")).toContain("fix the bug");
    const toolParent = tool.parentSpanId;
    const genContext = generation.spanContext().spanId;
    expect(toolParent).toBe(genContext);
    expect(generation.parentSpanId).toBe(agent.spanContext().spanId);

    await client.shutdown();
  });
});

describe("SoftprobeSessionTracer edge cases", () => {
  it("records retries, reasoning, compaction, and failed steps", async () => {
    const { tracer, exporter, client } = await createTracer();
    const sessionID = "sess-edge";
    const t0 = Date.now();

    tracer.traceUserMessage({
      sessionID,
      messageID: "u1",
      parts: [{ type: "text", text: "go" }],
    });
    tracer.startActiveGenerationStep({
      sessionID,
      agent: "build",
      model: { providerID: "openai", id: "gpt-4.1" },
      started: t0,
    });

    tracer.traceEvent({
      id: "retry-1",
      sessionID,
      name: "opencode.generation.retry",
      timestamp: t0 + 1,
      output: { message: "rate limit" },
      metadata: { attempt: 1 },
    });

    tracer.traceReasoning({
      reasoningID: "r1",
      sessionID,
      timestamp: t0 + 2,
      text: "thinking...",
      source: "session.next.reasoning.ended",
    });

    tracer.traceEvent({
      id: "compact-1",
      sessionID,
      name: "opencode.generation.compaction",
      timestamp: t0 + 3,
      output: { text: "summary" },
    });

    tracer.traceFailedGenerationStep({
      id: "fail-1",
      sessionID,
      completed: t0 + 4,
      error: { message: "boom" },
    });

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toContain("opencode.generation.retry");
    expect(names).toContain("opencode.generation.reasoning");
    expect(names).toContain("opencode.generation.compaction");

    const failed = exporter
      .getFinishedSpans()
      .find((s) => s.name === "opencode.generation");
    expect(failed?.status.code).toBe(2); // ERROR

    await client.shutdown();
  });

  it("marks abort without treating MessageAbortedError as span ERROR", async () => {
    const { tracer, exporter, client } = await createTracer();
    const sessionID = "sess-abort";

    tracer.traceUserMessage({
      sessionID,
      messageID: "u-abort",
      parts: [{ type: "text", text: "stop" }],
    });
    tracer.startActiveGenerationStep({
      sessionID,
      agent: "build",
      model: { providerID: "openai", id: "gpt-4.1" },
      started: Date.now(),
    });
    tracer.traceToolStart({
      sessionID,
      callID: "c-abort",
      tool: "bash",
      args: {},
    });

    tracer.traceSessionError({
      sessionID,
      error: { name: "MessageAbortedError", message: "aborted" },
    });

    await client.forceFlush();
    const tool = exporter
      .getFinishedSpans()
      .find((s) => attr(s, "sp.observation.type") === "tool");
    expect(attr(tool!, "sp.tool.status")).toBe("cancelled");

    const before = exporter.getFinishedSpans().length;
    tracer.traceGeneration({
      sessionID,
      messageID: "a-abort",
      parentID: "u-abort",
      modelID: "gpt-4.1",
      providerID: "openai",
      mode: "build",
      created: Date.now(),
      completed: Date.now(),
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    await client.forceFlush();
    // Aborted sessions skip late generation finalization.
    expect(exporter.getFinishedSpans().length).toBe(before);

    await client.shutdown();
  });

  it("captures completed tool parts and dedupes against tool.execute hooks", async () => {
    const { tracer, exporter, client } = await createTracer();
    const sessionID = "sess-tool-part";

    tracer.traceUserMessage({
      sessionID,
      messageID: "u1",
      parts: [{ type: "text", text: "list files" }],
    });

    // Same call via execute hooks then message.part.updated should yield one tool.
    tracer.traceToolStart({
      sessionID,
      callID: "call_read_1",
      tool: "read",
      args: { filePath: "/tmp" },
    });
    tracer.traceToolEnd({
      sessionID,
      callID: "call_read_1",
      tool: "read",
      args: { filePath: "/tmp" },
      title: "tmp",
      output: "a.txt",
    });
    tracer.traceToolPart({
      id: "prt_1",
      type: "tool",
      sessionID,
      messageID: "a1",
      callID: "call_read_1",
      tool: "read",
      state: {
        status: "completed",
        title: "tmp",
        input: { filePath: "/tmp" },
        output: "a.txt",
        time: { start: Date.now(), end: Date.now() },
      },
    });

    // A second tool only seen via part updates still records.
    tracer.traceToolPart({
      id: "prt_2",
      type: "tool",
      sessionID,
      messageID: "a1",
      callID: "call_bash_2",
      tool: "bash",
      state: {
        status: "completed",
        title: "ls",
        input: { command: "ls" },
        output: "ok",
        time: { start: Date.now(), end: Date.now() },
      },
    });

    tracer.finalizeSessionTracing();
    await client.forceFlush();

    const tools = exporter
      .getFinishedSpans()
      .filter((s) => attr(s, "sp.observation.type") === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((s) => attr(s, "gen_ai.tool.name")).sort()).toEqual([
      "bash",
      "read",
    ]);

    await client.shutdown();
  });
});
