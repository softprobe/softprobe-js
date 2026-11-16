# `@softprobe/tracing`

TypeScript/Node instrumentation SDK for Softprobe LLM observability.

## Install

```bash
pnpm add @softprobe/tracing
```

## Quick start

```ts
import { SoftprobeClient } from "@softprobe/tracing";

const client = SoftprobeClient.fromEnv({ serviceName: "my-app" });

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

For staging, standard OTLP environment variables configure the trace exporter:

```sh
export INGESTION_KEY="<Ingestion Key>"
export SOFTPROBE_BASE_URL="https://explorer-staging.softprobe.ai/api/thelake"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://explorer-staging.softprobe.ai/api/thelake/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer ${INGESTION_KEY}"
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=staging"
```

`SOFTPROBE_BASE_URL` selects the API base for score writes. A full trace-specific endpoint is used as written; a generic `OTEL_EXPORTER_OTLP_ENDPOINT` is a base URL and gets `/v1/traces` appended.

The same values can be passed directly to the SDK:

```ts
const client = new SoftprobeClient({
  ingestionKey: "<Ingestion Key>",
  baseUrl: "https://explorer-staging.softprobe.ai/api/thelake",
  otlp: {
    tracesEndpoint: "https://explorer-staging.softprobe.ai/api/thelake/v1/traces",
    protocol: "http/protobuf",
  },
  resourceAttributes: { "deployment.environment.name": "staging" },
});
```

See `docs/sdk-contract.md` for the shared contract with the Python SDK.
