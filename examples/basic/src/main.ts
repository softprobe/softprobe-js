/**
 * Softprobe basic example — matches Agent QA env credentials.
 *
 *   export SOFTPROBE_PUBLIC_KEY=…
 *   export SOFTPROBE_BASE_URL=…
 *   npm start
 */
import { SoftprobeClient } from "@softprobe/tracing";

async function main() {
  const client = SoftprobeClient.fromEnv({
    serviceName: "softprobe-js-example-basic",
  });

  const sessionId =
    process.env.SOFTPROBE_SESSION_ID?.trim() || "example-basic-thread";

  const agent = client.startAgent({
    name: "example.agent",
    sessionId,
    input: { goal: "say hello" },
  });

  const generation = client.startGeneration({
    name: "example.generation",
    parent: agent,
    sessionId,
    model: "example-model",
    provider: "example",
    input: { messages: [{ role: "user", content: "hello" }] },
  });
  generation.update({
    output: { content: "hello from Softprobe" },
    usage: { inputTokens: 4, outputTokens: 6 },
  });
  generation.end();
  agent.end({ output: { ok: true } });

  await client.forceFlush();
  await client.shutdown();
  console.log(
    JSON.stringify({
      ok: true,
      sessionId,
      message: "flushed agent + generation — check Explorer Sessions",
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
