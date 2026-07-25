# `@softprobe/tracing`

TypeScript/Node instrumentation SDK for Softprobe LLM observability.

## Install

```bash
pnpm add @softprobe/tracing
```

## Quick start

```ts
import {
  SoftprobeClient,
  resolveSoftprobeConfigFromEnv,
} from "@softprobe/tracing";

const env = resolveSoftprobeConfigFromEnv();
const client = new SoftprobeClient({
  publicKey: env?.publicKey ?? process.env.SOFTPROBE_PUBLIC_KEY!,
  baseUrl: env?.baseUrl ?? process.env.SOFTPROBE_BASE_URL!,
  serviceName: "my-app",
});

await client.withGeneration(
  {
    name: "chat",
    model: "gpt-4o-mini",
    provider: "openai",
    usage: { inputTokens: 10, outputTokens: 4 },
  },
  async (generation) => {
    generation.update({ output: { content: "hello" } });
  },
);

await client.forceFlush();
await client.shutdown();
```

See `docs/sdk-contract.md` for the shared contract with the Python SDK.
