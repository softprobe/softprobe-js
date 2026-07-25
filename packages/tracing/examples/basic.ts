/**
 * Runnable example for @softprobe/tracing.
 *
 *   pnpm --filter @softprobe/tracing build
 *   node --import tsx packages/tracing-js/examples/basic.ts
 *
 * Or against a local stack with env overrides.
 */
import { SoftprobeClient, resolveSoftprobeConfigFromEnv } from "../src/index.js";

async function main(): Promise<void> {
  const envConfig = resolveSoftprobeConfigFromEnv();
  const client = new SoftprobeClient({
    publicKey: envConfig?.publicKey ?? "e2e-token",
    baseUrl: envConfig?.baseUrl ?? "http://127.0.0.1:8091",
    otlpEndpoint: envConfig?.otlpEndpoint,
    serviceName: "softprobe-tracing-example",
    sessionId: "sess-example-ts",
    environment: envConfig?.environment ?? "dev",
  });

  await client.withObservation(
    { name: "example.agent", asType: "agent", input: { q: "hello" } },
    async () => {
      await client.withGeneration(
        {
          name: "example.generation",
          model: "gpt-4o-mini",
          provider: "openai",
          usage: { inputTokens: 10, outputTokens: 5 },
          output: { content: "hi" },
        },
        async () => undefined,
      );
    },
  );

  await client.forceFlush();
  await client.shutdown();
  console.log("example complete");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
