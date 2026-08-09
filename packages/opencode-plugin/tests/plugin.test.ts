import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { SoftprobeClient, normalizeReadableSpans } from "@softprobe/tracing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SoftprobePlugin,
  createHooksFromTracer,
  createSoftprobeSessionTracer,
} from "../src/index.js";
import { SoftprobeSessionTracer } from "../src/softprobe.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  vi.restoreAllMocks();
});

describe("createSoftprobeSessionTracer", () => {
  it("does not register a global TracerProvider by default", async () => {
    const exporter = new InMemorySpanExporter();
    const tracer = createSoftprobeSessionTracer({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      spanExporter: exporter,
      useSimpleProcessor: true,
    });
    // Private provider still exports Softprobe spans.
    const agent = tracer.client.startAgent({ name: "probe" });
    agent.end();
    await tracer.client.forceFlush();
    expect(exporter.getFinishedSpans().length).toBe(1);
    await tracer.shutdown();
  });

  it("records full message and tool payloads", async () => {
    const exporter = new InMemorySpanExporter();
    const tracer = createSoftprobeSessionTracer({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      spanExporter: exporter,
      useSimpleProcessor: true,
    });
    const tool = tracer.client.startTool({
      name: "bash",
      toolName: "bash",
      input: { command: "echo hi" },
    });
    tool.end({ output: { stdout: "hi" } });
    await tracer.client.forceFlush();
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["sp.input"]).toContain("echo hi");
    expect(span.attributes["sp.output"]).toContain("hi");
    await tracer.shutdown();
  });
});

describe("createHooksFromTracer", () => {
  it("maps chat/tool/event hooks to agent→generation→tool", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      serviceName: "opencode",
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });
    const sessionTracer = new SoftprobeSessionTracer(client);
    const hooks = createHooksFromTracer(sessionTracer);
    const sessionID = "sess-hooks-1";
    const t0 = Date.parse("2024-07-19T12:00:00.000Z");

    await hooks["chat.message"]?.(
      {
        sessionID,
        messageID: "msg-user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4.1" },
      } as never,
      { parts: [{ type: "text", text: "hi" }] } as never,
    );

    await hooks.event?.({
      event: {
        id: "step-1",
        type: "session.next.step.started",
        properties: {
          sessionID,
          timestamp: t0,
          agent: "build",
          model: { providerID: "openai", id: "gpt-4.1" },
        },
      },
    } as never);

    await hooks["tool.execute.before"]?.(
      { sessionID, callID: "call-1", tool: "bash" } as never,
      { args: { command: "ls" } } as never,
    );
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: "call-1",
        tool: "bash",
        args: { command: "ls" },
      } as never,
      { title: "ls", output: "ok" } as never,
    );

    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call-1",
            type: "tool",
            messageID: "msg-asst",
            tool: "bash",
          },
        },
      },
    } as never);
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "text-1",
            type: "text",
            messageID: "msg-asst",
            text: "done",
          },
        },
      },
    } as never);

    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            id: "msg-asst",
            sessionID,
            parentID: "msg-user",
            modelID: "gpt-4.1",
            providerID: "openai",
            mode: "build",
            finish: "stop",
            cost: 0.01,
            tokens: {
              input: 3,
              output: 2,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: { created: t0, completed: t0 + 1000 },
          },
        },
      },
    } as never);

    await hooks.event?.({
      event: { type: "session.idle", properties: {} },
    } as never);

    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    expect(spans.some((s) => s.observation_type === "agent")).toBe(true);
    expect(spans.some((s) => s.observation_type === "generation")).toBe(true);
    expect(spans.some((s) => s.observation_type === "tool")).toBe(true);
    const tool = spans.find((s) => s.observation_type === "tool")!;
    expect(tool.attributes["gen_ai.tool.call.id"]).toBe("call-1");
    expect(tool.parent_name).toBe("opencode.generation");

    await hooks.dispose?.();
  });

  it("captures raw MCP CallToolResult content into sp.output", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      serviceName: "opencode",
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });
    const sessionTracer = new SoftprobeSessionTracer(client);
    const hooks = createHooksFromTracer(sessionTracer);
    const sessionID = "sess-mcp-1";
    const t0 = Date.parse("2024-07-19T12:00:00.000Z");

    await hooks["chat.message"]?.(
      {
        sessionID,
        messageID: "msg-user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4.1" },
      } as never,
      { parts: [{ type: "text", text: "read doc" }] } as never,
    );
    await hooks.event?.({
      event: {
        id: "step-1",
        type: "session.next.step.started",
        properties: {
          sessionID,
          timestamp: t0,
          agent: "build",
          model: { providerID: "openai", id: "gpt-4.1" },
        },
      },
    } as never);

    await hooks["tool.execute.before"]?.(
      {
        sessionID,
        callID: "call-mcp-1",
        tool: "lark-mcp_docx_v1_document_rawContent",
      } as never,
      {
        args: { path: { document_id: "DJQr" } },
      } as never,
    );
    // OpenCode MCP path currently passes raw CallToolResult here.
    await hooks["tool.execute.after"]?.(
      {
        sessionID,
        callID: "call-mcp-1",
        tool: "lark-mcp_docx_v1_document_rawContent",
        args: { path: { document_id: "DJQr" } },
      } as never,
      {
        content: [{ type: "text", text: "# Document body" }],
      } as never,
    );

    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    const tool = spans.find((s) => s.observation_type === "tool")!;
    expect(tool.attributes["sp.output"]).toContain("# Document body");
    expect(tool.attributes["sp.output"]).not.toBe("{}");
    expect(tool.attributes["sp.tool.kind"]).toBe("mcp");

    await hooks.dispose?.();
  });
});

describe("SoftprobePlugin", () => {
  it("returns empty hooks when credentials are missing", async () => {
    delete process.env.SOFTPROBE_PUBLIC_KEY;
    delete process.env.SOFTPROBE_BASE_URL;
    const hooks = await SoftprobePlugin({} as never);
    expect(hooks).toEqual({});
  });

  it("wires credentials from env into working hooks", async () => {
    process.env.SOFTPROBE_PUBLIC_KEY = "e2e-token";
    process.env.SOFTPROBE_BASE_URL = "http://127.0.0.1:8091";
    process.env.SOFTPROBE_OTLP_ENDPOINT = "http://127.0.0.1:8091/v1/traces";

    // SoftprobePlugin creates a real OTLP exporter; we only assert hooks exist.
    const hooks = await SoftprobePlugin({} as never);
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
    await hooks.dispose?.();
  });
});
