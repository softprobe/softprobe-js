import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { context, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { SoftprobeClient } from "../src/client.js";
import { normalizeReadableSpans } from "../src/normalize.js";
import { redactValue } from "../src/redaction.js";
import { buildScoreRequest } from "../src/scores.js";
import type { ScoreRequest, ScoreTransport } from "../src/types.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Prefer authoritative fixtures from sp-llm when SOFTPROBE_CONTRACTS_ROOT is set. */
const contractsRoot = process.env.SOFTPROBE_CONTRACTS_ROOT
  ? process.env.SOFTPROBE_CONTRACTS_ROOT
  : join(root, "contracts");
const fixtures = join(contractsRoot, "fixtures");

class MemoryScoreTransport implements ScoreTransport {
  requests: ScoreRequest[] = [];
  async createScore(request: ScoreRequest): Promise<void> {
    this.requests.push(request);
  }
}

async function createClient(overrides: {
  redactKeys?: string[];
  sessionId?: string;
  userId?: string;
  tags?: string[];
} = {}) {
  const exporter = new InMemorySpanExporter();
  const scores = new MemoryScoreTransport();
  const client = new SoftprobeClient({
    publicKey: "test-key",
    baseUrl: "http://127.0.0.1:8091",
    otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
    serviceName: "softprobe-sdk-contract",
    serviceVersion: "0.1.0",
    environment: "test",
    sessionId: overrides.sessionId,
    userId: overrides.userId,
    tags: overrides.tags,
    redactKeys: overrides.redactKeys,
    spanExporter: exporter,
    scoreTransport: scores,
    useSimpleProcessor: true,
  });
  return { client, exporter, scores };
}

afterEach(async () => {
  // ensure no leftover global provider between tests handled in shutdown
});

describe("SoftprobeClient configuration", () => {
  it("rejects missing publicKey", () => {
    expect(
      () =>
        new SoftprobeClient({
          publicKey: "",
          baseUrl: "http://localhost",
        }),
    ).toThrow(/publicKey/);
  });

  it("derives otlpEndpoint from baseUrl when omitted", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      publicKey: "test-key",
      baseUrl: "http://127.0.0.1:8091",
      spanExporter: exporter,
      useSimpleProcessor: true,
    });
    client.startObservation({ name: "ping", asType: "span" }).end();
    await client.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    await client.shutdown();
  });
});

describe("historical timestamps", () => {
  it("honors startTime on start and endTime on end", async () => {
    const { client, exporter } = await createClient();
    const startMs = Date.parse("2024-07-19T12:00:00.000Z");
    const endMs = Date.parse("2024-07-19T12:00:05.000Z");
    const agent = client.startAgent({
      name: "opencode.turn",
      startTime: startMs,
    });
    const generation = client.startGeneration({
      name: "opencode.generation",
      parent: agent,
      startTime: new Date(startMs + 100),
    });
    generation.end({ endTime: endMs });
    agent.end({ endTime: endMs + 50 });
    await client.forceFlush();
    const spans = exporter.getFinishedSpans();
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName["opencode.turn"].startTime[0]).toBe(
      Math.floor(startMs / 1000),
    );
    expect(byName["opencode.generation"].startTime[0]).toBe(
      Math.floor((startMs + 100) / 1000),
    );
    expect(byName["opencode.generation"].endTime[0]).toBe(
      Math.floor(endMs / 1000),
    );
    expect(byName["opencode.turn"].endTime[0]).toBe(
      Math.floor((endMs + 50) / 1000),
    );
    await client.shutdown();
  });
});

describe("nesting and context", () => {
  it("propagates parent/child relationships", async () => {
    const { client, exporter } = await createClient();
    await client.withObservation({ name: "parent", asType: "agent" }, async () => {
      await client.withObservation({ name: "child", asType: "tool" }, async () => {
        return "ok";
      });
    });
    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    const child = spans.find((s) => s.name === "child");
    expect(child?.parent_name).toBe("parent");
    await client.shutdown();
  });

  it("root: true detaches from the ambient span and starts a new trace", async () => {
    const { client, exporter } = await createClient();
    const ambient = client.startAgent({ name: "ambient" });
    const ctx = trace.setSpan(context.active(), ambient.otelSpan);
    let adoptedTraceId: string | undefined;
    let detached: ReturnType<typeof client.startAgent> | undefined;
    context.with(ctx, () => {
      adoptedTraceId = client.startAgent({ name: "adopted" }).traceId;
      detached = client.startAgent({ name: "detached", root: true });
    });
    expect(adoptedTraceId).toBe(ambient.traceId);
    expect(detached!.traceId).not.toBe(ambient.traceId);
    detached!.end();
    ambient.end();
    await client.forceFlush();
    const raw = exporter.getFinishedSpans();
    const detachedSpan = raw.find((s) => s.name === "detached")!;
    expect(detachedSpan.parentSpanId).toBeUndefined();
    await client.shutdown();
  });

  it("startTool applies defaults and normalizes unknown kinds", async () => {
    const { client, exporter } = await createClient();
    const tool = client.startTool({ name: "lookup" });
    tool.end();
    const custom = client.startTool({
      name: "custom.run",
      toolName: "custom",
      toolCallId: "call_custom_1",
      kind: "not-a-kind",
      index: 2,
      mcpServer: "srv",
      mcpTool: "srv.tool",
    });
    custom.end();
    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName.lookup.observation_type).toBe("tool");
    expect(byName.lookup.attributes["gen_ai.tool.name"]).toBe("lookup");
    expect(byName.lookup.attributes["sp.tool.kind"]).toBe("function");
    expect(byName.lookup.attributes["sp.tool.status"]).toBe("ok");
    expect(byName.lookup.attributes["gen_ai.tool.call.id"]).toBeUndefined();
    expect(byName["custom.run"].attributes["gen_ai.tool.name"]).toBe("custom");
    expect(byName["custom.run"].attributes["gen_ai.tool.call.id"]).toBe(
      "call_custom_1",
    );
    expect(byName["custom.run"].attributes["sp.tool.kind"]).toBe("other");
    expect(byName["custom.run"].attributes["sp.tool.index"]).toBe(2);
    expect(byName["custom.run"].attributes["sp.mcp.server"]).toBe("srv");
    expect(byName["custom.run"].attributes["sp.mcp.tool"]).toBe("srv.tool");
    await client.shutdown();
  });

  it("marks ERROR status on scoped helper exceptions", async () => {
    const { client, exporter } = await createClient();
    await expect(
      client.withObservation({ name: "boom", asType: "span" }, async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    await client.forceFlush();
    const spans = normalizeReadableSpans(exporter.getFinishedSpans());
    expect(spans[0]?.status_code).toBe("ERROR");
    expect(spans[0]?.status_message).toBe("fail");
    await client.shutdown();
  });
});

describe("observation types and generation mapping", () => {
  it("emits all canonical observation types matching contract fixture", async () => {
    const expected = JSON.parse(
      readFileSync(join(fixtures, "expected-nested-spans.json"), "utf8"),
    );
    const { client, exporter } = await createClient();

    await client.withObservation(
      {
        name: "agent.run",
        asType: "agent",
        sessionId: "sess-contract-1",
        userId: "user-contract-1",
        tags: ["contract", "nested"],
        input: { goal: "answer question" },
      },
      async () => {
        await client.withObservation(
          {
            name: "chain.plan",
            asType: "chain",
            sessionId: "sess-contract-1",
          },
          async () => {
          await client.withObservation(
            {
              name: "retriever.search",
              asType: "retriever",
              input: { query: "docs" },
              output: { docs: ["a", "b"] },
            },
            async () => {
              const emb = client.startEmbedding({
                name: "embedding.encode",
                attributes: {
                  "gen_ai.request.model": "text-embedding-3-small",
                  "gen_ai.usage.input_tokens": 12,
                  "gen_ai.usage.total_tokens": 12,
                },
              });
              emb.end();
            },
          );
        });

        await client.withGeneration(
          {
            name: "generation.answer",
            sessionId: "sess-contract-1",
            model: "gpt-4o-mini",
            provider: "openai",
            operationName: "chat",
            modelParameters: { temperature: 0.2, maxTokens: 128 },
            usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
            cost: { input: 0.0001, output: 0.0002, total: 0.0003 },
            prompt: { name: "answer", version: 1 },
            input: { messages: [{ role: "user", content: "hi" }] },
            output: {
              content: null,
              tool_calls: [
                {
                  id: "call_lookup_1",
                  name: "lookup",
                  arguments: '{"name":"lookup"}',
                },
              ],
            },
            promptEvent: [{ role: "user", content: "hi" }],
            completionEvent: [
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_lookup_1",
                    name: "lookup",
                    arguments: '{"name":"lookup"}',
                  },
                ],
              },
            ],
            inferenceDetails: { provider: "openai", model: "gpt-4o-mini" },
            attributes: {
              "sp.tool.available_names": ["lookup"],
              "sp.tool.available_count": 1,
              "sp.tool.call_names": ["lookup"],
              "sp.tool.call_count": 1,
              "sp.tool.call_ids": ["call_lookup_1"],
            },
          },
          async (generation) => {
            generation.update({
              responseModel: "gpt-4o-mini-2024-07-18",
              responseId: "chatcmpl-contract-1",
              finishReasons: ["tool_calls"],
            });
            const tool = client.startTool({
              name: "tool.lookup",
              toolName: "lookup",
              toolCallId: "call_lookup_1",
              kind: "function",
              status: "ok",
              index: 0,
              parent: generation,
              input: { name: "lookup" },
              output: { ok: true },
            });
            tool.addContentEvent("gen_ai.tool.message", {
              role: "tool",
              name: "lookup",
              tool_call_id: "call_lookup_1",
              content: "ok",
            });
            tool.end();
          },
        );

        client.startEvaluator({
          name: "evaluator.quality",
          output: { score: 0.9 },
        }).end();
        client.startGuardrail({
          name: "guardrail.check",
          output: { passed: true },
        }).end();
        client.startObservation({ name: "span.helper", asType: "span" }).end();
      },
    );

    await client.forceFlush();
    const actual = normalizeReadableSpans(exporter.getFinishedSpans());
    const expectedSorted = [...expected].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(actual).toEqual(expectedSorted);
    await client.shutdown();
  });
});

describe("privacy", () => {
  it("redacts sensitive keys", () => {
    const privacy = JSON.parse(
      readFileSync(join(fixtures, "privacy-redaction.json"), "utf8"),
    );
    expect(redactValue(privacy.exampleInput, privacy.redactKeys)).toEqual(
      privacy.exampleOutputCaptured,
    );
  });
});

describe("scores", () => {
  it("validates and sends score payloads matching fixtures", async () => {
    const expected = JSON.parse(
      readFileSync(join(fixtures, "expected-scores.json"), "utf8"),
    );
    const { client, scores } = await createClient();
    for (const score of expected) {
      await client.createScore({
        scoreId: score.score_id,
        timestamp: score.timestamp,
        traceId: score.trace_id ?? undefined,
        spanId: score.span_id ?? undefined,
        sessionId: score.session_id ?? undefined,
        name: score.name,
        dataType: score.data_type,
        numericValue: score.numeric_value ?? undefined,
        stringValue: score.string_value ?? undefined,
        booleanValue: score.boolean_value ?? undefined,
        source: score.source,
        comment: score.comment ?? undefined,
        configId: score.config_id ?? undefined,
        authorId: score.author_id ?? undefined,
        metadata: score.metadata,
      });
    }
    expect(scores.requests).toEqual(expected);
    await client.shutdown();
  });

  it("rejects invalid scores before transport", () => {
    expect(() =>
      buildScoreRequest({
        scoreId: "x",
        name: "n",
        dataType: "numeric",
        source: "api",
      }),
    ).toThrow(/target/);
  });
});

describe("lifecycle", () => {
  it("supports forceFlush, double-end, and shutdown no-op", async () => {
    const { client, exporter } = await createClient();
    const obs = client.startObservation({ name: "life", asType: "span" });
    obs.end();
    obs.end();
    await client.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    await client.shutdown();
    await client.shutdown();
  });
});

describe("status helpers", () => {
  it("exposes finished spans for exporters", async () => {
    const { client, exporter } = await createClient();
    client.startObservation({ name: "a", asType: "event" }).end();
    await client.forceFlush();
    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    expect(spans[0]?.name).toBe("a");
    await client.shutdown();
  });
});

describe("integer OTLP timestamps", () => {
  it("never ends spans with float/NaN hrTime components", async () => {
    const exporter = new InMemorySpanExporter();
    const client = new SoftprobeClient({
      publicKey: "pk",
      baseUrl: "http://127.0.0.1:8091",
      otlpEndpoint: "http://127.0.0.1:8091/v1/traces",
      spanExporter: exporter,
      useSimpleProcessor: true,
      registerProvider: false,
    });
    const agent = client.startAgent({ name: "turn", startTime: Number.NaN });
    agent.end({ endTime: Number.NaN }); // non-finite end must not bare-end
    const tool = client.startTool({
      name: "read",
      toolName: "read",
      startTime: Date.now() + 0.9,
    });
    tool.end({ endTime: Date.now() + 1.1 });
    await client.forceFlush();
    for (const span of exporter.getFinishedSpans()) {
      expect(Number.isInteger(span.startTime[0])).toBe(true);
      expect(Number.isInteger(span.startTime[1])).toBe(true);
      expect(Number.isInteger(span.endTime[0])).toBe(true);
      expect(Number.isInteger(span.endTime[1])).toBe(true);
      expect(Number.isFinite(span.startTime[0])).toBe(true);
      expect(Number.isFinite(span.startTime[1])).toBe(true);
      // Proto path: BigInt must accept both components
      expect(() => BigInt(span.startTime[0])).not.toThrow();
      expect(() => BigInt(span.startTime[1])).not.toThrow();
      expect(() => BigInt(span.endTime[0])).not.toThrow();
      expect(() => BigInt(span.endTime[1])).not.toThrow();
    }
    await client.shutdown();
  });
});
