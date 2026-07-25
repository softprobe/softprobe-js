import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { SoftprobeClient, normalizeReadableSpans } from "@softprobe/tracing";
import { CallbackHandler } from "../src/CallbackHandler.js";

function makeClient() {
  const exporter = new InMemorySpanExporter();
  const client = new SoftprobeClient({
    publicKey: "test-key",
    baseUrl: "http://127.0.0.1:8091",
    otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
    spanExporter: exporter,
    scoreTransport: { async createScore() {} },
    useSimpleProcessor: true,
    registerProvider: false,
    disableGlobalTracerOnShutdown: false,
  });
  return { client, exporter };
}

describe("Softprobe LangChain CallbackHandler", () => {
  it("links chain/tool/generation parents", async () => {
    const { client, exporter } = makeClient();
    const handler = new CallbackHandler({
      softprobeClient: client,
      sessionId: "sess-lc",
      metadata: { feature: "math" },
      tags: ["langchain"],
    });

    await handler.handleChainStart(
      { id: ["agent"], lc: 1, type: "not_implemented", name: "agent" },
      { input: "2+2" },
      "chain-1",
      undefined,
      ["t"],
      {},
      undefined,
      "agent",
    );
    await handler.handleToolStart(
      { id: ["calculator"], lc: 1, type: "not_implemented", name: "calculator" },
      "2+2",
      "tool-1",
      "chain-1",
      undefined,
      { tool_call_id: "call_calc_1" },
      "calculator",
    );
    await handler.handleToolEnd("4", "tool-1");
    await handler.handleChatModelStart(
      { id: ["ChatOpenAI"], lc: 1, type: "not_implemented" },
      [[new HumanMessage("summarize")]],
      "llm-1",
      "chain-1",
      {
        invocation_params: {
          model: "gpt-4o-mini",
          temperature: 0,
          tools: [
            {
              type: "function",
              function: { name: "calculator", parameters: { type: "object" } },
            },
          ],
        },
      },
      undefined,
      { ls_model_name: "gpt-4o-mini" },
      "ChatOpenAI",
    );
    await handler.handleLLMNewToken("4", 0, "llm-1");
    await handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "",
              message: new AIMessage({
                content: "",
                tool_calls: [
                  {
                    name: "calculator",
                    args: { expression: "2+2" },
                    id: "call_calc_1",
                  },
                ],
              }),
            } as unknown as ChatGenerationChunk,
          ],
        ],
        llmOutput: {
          tokenUsage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        },
      },
      "llm-1",
    );
    await handler.handleChainEnd({ output: "4" }, "chain-1");
    await client.forceFlush();

    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName.calculator.parent_name).toBe("agent");
    expect(byName.ChatOpenAI.parent_name).toBe("agent");
    expect(byName.ChatOpenAI.observation_type).toBe("generation");
    expect(byName.calculator.observation_type).toBe("tool");
    expect(byName.calculator.attributes["gen_ai.tool.name"]).toBe("calculator");
    expect(byName.calculator.attributes["gen_ai.tool.call.id"]).toBe("call_calc_1");
    expect(byName.calculator.attributes["sp.tool.kind"]).toBe("function");
    expect(byName.calculator.attributes["sp.tool.status"]).toBe("ok");
    expect(byName.ChatOpenAI.attributes["sp.tool.available_names"]).toEqual([
      "calculator",
    ]);
    expect(byName.ChatOpenAI.attributes["sp.tool.available_count"]).toBe(1);
    expect(byName.ChatOpenAI.attributes["sp.tool.call_names"]).toEqual([
      "calculator",
    ]);
    expect(byName.ChatOpenAI.attributes["sp.tool.call_ids"]).toEqual([
      "call_calc_1",
    ]);
    const toolEvents = byName.calculator.events.map((e) => e.name);
    expect(toolEvents).toContain("gen_ai.tool.message");
    expect(byName.agent.attributes["sp.session.id"]).toBe("sess-lc");
    expect(byName.agent.attributes["sp.metadata.feature"]).toBe("math");
    expect(handler.lastTraceId).toBeTruthy();
    await client.shutdown();
  });

  it("omits gen_ai.tool.call.id when no provider id is available", async () => {
    const { client, exporter } = makeClient();
    const handler = new CallbackHandler({ softprobeClient: client });

    await handler.handleToolStart(
      { id: ["calculator"], lc: 1, type: "not_implemented", name: "calculator" },
      "2+2",
      "tool-1",
      undefined,
      undefined,
      undefined,
      "calculator",
    );
    await handler.handleToolEnd("4", "tool-1");
    await client.forceFlush();

    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    const attrs = spans[0].attributes;
    expect(attrs["gen_ai.tool.name"]).toBe("calculator");
    expect(attrs["gen_ai.tool.call.id"]).toBeUndefined();
    await client.shutdown();
  });
});
