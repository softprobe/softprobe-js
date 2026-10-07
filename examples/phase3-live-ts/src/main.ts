import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import OpenAI from "openai";
import { SoftprobeClient, observeOpenAI } from "@softprobe/tracing";

const outPath = process.env.PHASE3_IDS_PATH!;
const sessionId = process.env.PHASE3_SESSION_ID!;
const model = process.env.PHASE3_MODEL ?? "gpt-4o-mini";
const apiKey = process.env.OPENAI_API_KEY!;
const baseUrl = process.env.SOFTPROBE_BASE_URL ?? "http://127.0.0.1:8090";
const publicKey = process.env.SOFTPROBE_PUBLIC_KEY ?? "e2e-token";
const otlpEndpoint =
  process.env.SOFTPROBE_OTLP_ENDPOINT ?? `${baseUrl}/v1/traces`;

async function main(): Promise<void> {
  const softprobe = new SoftprobeClient({
    publicKey,
    baseUrl,
    otlpEndpoint,
    serviceName: "phase3-live-ts-openai",
    serviceVersion: "0.1.0",
    environment: "e2e",
  });

  const raw = new OpenAI({ apiKey });
  const client = observeOpenAI(raw, {
    softprobeClient: softprobe,
    sessionId,
    generationName: "phase3.openai.chat",
  });

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "Reply with a single digit only." },
      { role: "user", content: "What is 1 + 1?" },
    ],
    temperature: 0,
    name: "phase3-openai-math",
    sessionId,
  });

  await softprobe.forceFlush();
  await softprobe.shutdown();

  const payload = {
    language: "typescript",
    provider: "openai",
    sessionId,
    traceId: client.lastGenerationTraceId,
    generationSpanId: client.lastGenerationSpanId,
    model,
    responseId: response.id,
    content: response.choices[0]?.message?.content ?? null,
    serviceName: "phase3-live-ts-openai",
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
