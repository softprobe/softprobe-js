# Softprobe

Topology-aware record & replay testing framework for Node.js via OpenTelemetry. Record real traffic (Postgres, Redis, HTTP) into NDJSON cassettes and replay it in tests without live dependencies.

## Installation

```bash
npm install softprobe
```

## Quick start

1. **Import first** (before any other imports that load drivers):

```ts
// instrumentation.ts
import "softprobe/init";

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
```

2. **Replay in tests** with `runWithContext`:

```ts
import { softprobe } from "softprobe";

it("replays from cassette", async () => {
  await softprobe.runWithContext(
    { traceId: "prod-trace-345", cassettePath: "./softprobe-cassettes.ndjson" },
    async () => {
      const res = await fetch("http://localhost:3000/users/1");
      expect(res.status).toBe(200);
    }
  );
});
```

## CLI — `softprobe diff`

Replay the recorded inbound request against a running service and compare. The CLI sends the request with **coordination headers** so the service can run in replay mode for that request.

### Usage

```bash
softprobe diff <cassette.ndjson> <targetUrl>
```

- **`cassette.ndjson`** — Path to the NDJSON cassette file (must contain an `inbound` record).
- **`targetUrl`** — Base URL of the target service (e.g. `http://localhost:3000`).

### How to generate the cassette

Send requests to your app with **coordination headers** so it records that traffic into an NDJSON file. No environment variables are required.

1. Run your app with Softprobe middleware (Express or Fastify) and `import "softprobe/init"` at startup.
2. For each request you want to record, send these HTTP headers:
   - **`x-softprobe-mode: CAPTURE`** — this request (and its outbound calls) will be recorded.
   - **`x-softprobe-cassette-path: <path>`** — path where the cassette will be written (e.g. `./softprobe-cassettes.ndjson`).
3. The middleware uses these headers and writes the inbound request/response (and any outbound records for that trace) to the given file. The cassette will contain at least one `inbound` record.

Example with curl:

```bash
curl -H "x-softprobe-mode: CAPTURE" \
     -H "x-softprobe-cassette-path: ./softprobe-cassettes.ndjson" \
     http://localhost:3000/your-route
```

Repeat for other routes or use the same path to append more records to the same cassette.

### How to run

- **Global (after install):**  
  `npx softprobe diff ./softprobe-cassettes.ndjson http://localhost:3000`

- **From this repo (after `npm run build`):**  
  `npm run diff -- ./softprobe-cassettes.ndjson http://localhost:3000`

- **Direct:**  
  `node dist/cli.js diff ./softprobe-cassettes.ndjson http://localhost:3000`

### What the CLI does

1. Loads the cassette and finds the **inbound** HTTP record.
2. Sends the same method and path to `<targetUrl>` with these headers:
   - `x-softprobe-mode: REPLAY`
   - `x-softprobe-trace-id: <traceId from record>`
   - `x-softprobe-cassette-path: <path to the cassette file>`
3. Prints the response body to stdout. Exit code is 0 on success, 1 on missing args, request failure, or missing inbound record.

Your service must use Softprobe middleware (Express or Fastify) so it reads these headers and runs that request in replay context. See [design.md](design.md) for the full coordination flow.

### Example

```bash
# Start your app (with Softprobe middleware) on port 3000, then:
npx softprobe diff ./softprobe-cassettes.ndjson http://localhost:3000
```

## More

- **Example app:** `examples/basic-app` — capture, replay, and custom matcher.
- **Design:** [design.md](design.md) — architecture, cassette format, and coordination headers.
