import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SoftprobeClient } from "@softprobe/tracing";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outPath =
  process.env.PHASE2_IDS_PATH ??
  join(root, "examples", ".phase2-ids-ts.json");

const sessionId = process.env.PHASE2_SESSION_ID ?? "sess-phase2-ts";
const baseUrl = process.env.SOFTPROBE_BASE_URL ?? "http://127.0.0.1:8090";
const publicKey = process.env.SOFTPROBE_PUBLIC_KEY ?? "e2e-token";
const otlpEndpoint =
  process.env.SOFTPROBE_OTLP_ENDPOINT ?? `${baseUrl}/v1/traces`;

async function main(): Promise<void> {
  const client = new SoftprobeClient({
    publicKey,
    baseUrl,
    otlpEndpoint,
    serviceName: "phase2-example-ts",
    serviceVersion: "0.1.0",
    environment: "e2e",
  });

  let traceId = "";
  let agentSpanId = "";
  let generationSpanId = "";

  await client.withObservation(
    {
      name: "phase2.agent",
      asType: "agent",
      sessionId,
      userId: "user-phase2-ts",
      tags: ["phase2", "typescript"],
      input: { goal: "phase2" },
    },
    async (agent) => {
      traceId = agent.traceId;
      agentSpanId = agent.spanId;

      await client.withObservation(
        { name: "phase2.chain", asType: "chain", sessionId },
        async () => {
          await client.withObservation(
            {
              name: "phase2.retriever",
              asType: "retriever",
              sessionId,
              input: { query: "docs" },
              output: { docs: ["a"] },
            },
            async () => {
              client
                .startEmbedding({
                  name: "phase2.embedding",
                  sessionId,
                  attributes: {
                    "gen_ai.request.model": "text-embedding-3-small",
                    "gen_ai.usage.input_tokens": 8,
                    "gen_ai.usage.total_tokens": 8,
                  },
                })
                .end();
            },
          );
        },
      );

      await client.withObservation(
        {
          name: "phase2.tool",
          asType: "tool",
          sessionId,
          input: { name: "lookup" },
          output: { ok: true },
        },
        async (tool) => {
          tool.addContentEvent("gen_ai.tool.message", {
            role: "tool",
            name: "lookup",
            content: "ok",
          });
        },
      );

      await client.withGeneration(
        {
          name: "phase2.generation",
          sessionId,
          model: "gpt-4o-mini",
          provider: "openai",
          operationName: "chat",
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          cost: { input: 0.0001, output: 0.0002, total: 0.0003 },
          input: { messages: [{ role: "user", content: "hi" }] },
          output: { content: "hello from ts" },
          promptEvent: [{ role: "user", content: "hi" }],
          completionEvent: [{ role: "assistant", content: "hello from ts" }],
        },
        async (generation) => {
          generationSpanId = generation.spanId;
          generation.update({
            responseModel: "gpt-4o-mini-2024-07-18",
            finishReasons: ["stop"],
          });
        },
      );

      client
        .startEvaluator({
          name: "phase2.evaluator",
          sessionId,
          output: { score: 0.95 },
        })
        .end();
      client
        .startGuardrail({
          name: "phase2.guardrail",
          sessionId,
          output: { passed: true },
        })
        .end();
      client
        .startObservation({ name: "phase2.span", asType: "span", sessionId })
        .end();
    },
  );

  const scoreIds = {
    span: `score-phase2-ts-span-${generationSpanId}`,
    trace: `score-phase2-ts-trace-${traceId.slice(0, 16)}`,
    session: `score-phase2-ts-session-${sessionId}`,
  };

  await client.createScore({
    scoreId: scoreIds.span,
    name: "faithfulness",
    dataType: "numeric",
    source: "evaluator",
    numericValue: 0.91,
    traceId,
    spanId: generationSpanId,
  });
  await client.createScore({
    scoreId: scoreIds.trace,
    name: "quality",
    dataType: "categorical",
    source: "api",
    stringValue: "good",
    traceId,
  });
  await client.createScore({
    scoreId: scoreIds.session,
    name: "thumbs",
    dataType: "boolean",
    source: "user",
    booleanValue: true,
    sessionId,
  });

  await client.forceFlush();
  await client.shutdown();

  const payload = {
    language: "typescript",
    sessionId,
    traceId,
    agentSpanId,
    generationSpanId,
    scoreIds,
    serviceName: "phase2-example-ts",
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
