import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SoftprobeClient,
  recordToolCalls,
  recordToolDefinitions,
} from "@softprobe/tracing";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outPath =
  process.env.TOOL_CALL_IDS_PATH ??
  join(root, "examples", ".tool-call-ids-ts.json");

const sessionId = process.env.TOOL_CALL_SESSION_ID ?? "sess-tool-call-ts";
const baseUrl = process.env.SOFTPROBE_BASE_URL ?? "http://127.0.0.1:8090";
const publicKey = process.env.SOFTPROBE_PUBLIC_KEY ?? "e2e-token";
const otlpEndpoint =
  process.env.SOFTPROBE_OTLP_ENDPOINT ?? `${baseUrl}/v1/traces`;

const tools = [
  {
    type: "function",
    function: {
      name: "lookup",
      description: "Lookup a document",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
      },
    },
  },
];

const toolCalls = [
  {
    id: "call_lookup_1",
    type: "function",
    function: { name: "lookup", arguments: '{"q":"docs"}' },
  },
];

async function main(): Promise<void> {
  const client = new SoftprobeClient({
    publicKey,
    baseUrl,
    otlpEndpoint,
    serviceName: "tool-call-example-ts",
    serviceVersion: "0.1.0",
    environment: "e2e",
  });

  let traceId = "";
  let agentSpanId = "";
  let generationSpanId = "";
  let toolSpanId = "";

  await client.withObservation(
    {
      name: "toolcall.agent",
      asType: "agent",
      sessionId,
      userId: "user-tool-call-ts",
      tags: ["tool-call", "typescript"],
      input: { goal: "answer with tools" },
    },
    async (agent) => {
      traceId = agent.traceId;
      agentSpanId = agent.spanId;

      await client.withGeneration(
        {
          name: "toolcall.generation",
          sessionId,
          model: "gpt-4o-mini",
          provider: "openai",
          operationName: "chat",
          usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
          input: {
            messages: [{ role: "user", content: "find docs" }],
            tools,
          },
          output: {
            content: null,
            tool_calls: [
              {
                id: "call_lookup_1",
                name: "lookup",
                arguments: '{"q":"docs"}',
              },
            ],
          },
          promptEvent: [{ role: "user", content: "find docs" }],
          completionEvent: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_lookup_1",
                  name: "lookup",
                  arguments: '{"q":"docs"}',
                },
              ],
            },
          ],
        },
        async (generation) => {
          generationSpanId = generation.spanId;
          recordToolDefinitions(generation, tools);
          recordToolCalls(generation, toolCalls);
          generation.update({
            responseModel: "gpt-4o-mini-2024-07-18",
            finishReasons: ["tool_calls"],
          });

          const tool = client.startTool({
            name: "toolcall.lookup",
            toolName: "lookup",
            toolCallId: "call_lookup_1",
            kind: "function",
            status: "ok",
            index: 0,
            parent: generation,
            sessionId,
            input: { q: "docs" },
            output: { ok: true, hits: ["a"] },
          });
          toolSpanId = tool.spanId;
          tool.addContentEvent("gen_ai.tool.message", {
            role: "tool",
            name: "lookup",
            tool_call_id: "call_lookup_1",
            content: "ok",
          });
          tool.end();
        },
      );
    },
  );

  const payload = {
    language: "typescript",
    serviceName: "tool-call-example-ts",
    sessionId,
    traceId,
    agentSpanId,
    generationSpanId,
    toolSpanId,
    toolCallId: "call_lookup_1",
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload));
  await client.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
