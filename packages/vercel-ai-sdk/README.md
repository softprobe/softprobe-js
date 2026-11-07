# @softprobe/vercel-ai-sdk

OpenTelemetry integration for the Vercel AI SDK. It adds Softprobe observation
types to model and tool spans and carries the application's existing
conversation ID onto each framework span.

## Install

```sh
npm install ai @ai-sdk/otel @softprobe/tracing @softprobe/vercel-ai-sdk
```

Set `SOFTPROBE_PUBLIC_KEY` and `SOFTPROBE_BASE_URL` in the application process
using the ingest key and Explorer `/api/thelake` base URL from Blackbox setup.
The Agent key writes telemetry; it does not grant Session read access.

## Register the integration

```ts
import { registerTelemetry } from "ai";
import { SoftprobeClient } from "@softprobe/tracing";
import { SoftprobeVercelAiSdkIntegration } from "@softprobe/vercel-ai-sdk";

const softprobe = SoftprobeClient.fromEnv({ serviceName: "my-agent" });
registerTelemetry(
  new SoftprobeVercelAiSdkIntegration({ tracer: softprobe.tracer }),
);
```

Pass the application's existing conversation ID as runtime context for each
generation. The Vercel AI telemetry filter excludes runtime context by default,
so explicitly include the ID field:

```ts
const result = await generateText({
  model,
  messages,
  runtimeContext: { sessionId: conversation.id },
  telemetry: { includeRuntimeContext: { sessionId: true } },
});
```

The integration maps `sessionId` to `session.id`, `sp.session.id`, and
`gen_ai.conversation.id`, letting Explorer associate framework spans with the
browser and HTTP spans from that conversation. Softprobe does not generate an
application session ID.

Vercel AI telemetry can include model inputs, outputs, and tool data. Review
your application's data policy and the AI SDK telemetry recording options
before enabling it with production conversations.
