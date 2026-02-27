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

2. **Replay in tests** with `run({ mode, storage, traceId }, fn)`:

```ts
import { softprobe } from "softprobe";

it("replays from cassette", async () => {
  const storage = {
    async loadTrace() {
      // Load and return records for the trace bound to this cassette.
      return [];
    },
    async saveRecord(_record) {
      // Replay-only example: no-op for writes.
    },
  };

  await softprobe.run(
    { mode: "REPLAY", storage: storage, traceId: "prod-trace-345" },
    async () => {
      const res = await fetch("http://localhost:3000/users/1");
      expect(res.status).toBe(200);
    }
  );
});
```

3. **Run the end-to-end example flow** (capture -> replay -> diff):

```bash
npm run example:test
```

For a step-by-step walkthrough, see [examples/basic-app/README.md](examples/basic-app/README.md).

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

1. Run your app with Softprobe middleware (Express or Fastify) and `import "softprobe/init"` at startup. Configure **cassetteDirectory** in config so the server knows where to read/write cassette files. Per-trace files are always `{cassetteDirectory}/{traceId}.ndjson`. (Config may still contain `cassettePath` for backward compatibility; init derives the directory from it.)
2. For each request you want to record, send these HTTP headers:
   - **`x-softprobe-mode: CAPTURE`** — this request (and its outbound calls) will be recorded.
   - **`x-softprobe-trace-id: <id>`** — trace id for this request; the cassette file will be `{cassetteDirectory}/{id}.ndjson`.
3. The middleware uses these headers and writes the inbound request/response (and any outbound records for that trace) to `{cassetteDirectory}/{traceId}.ndjson`. The cassette will contain at least one `inbound` record.

Example with curl (server must have cassetteDirectory configured, e.g. via config):

```bash
curl -H "x-softprobe-mode: CAPTURE" \
     -H "x-softprobe-trace-id: my-trace-1" \
     http://localhost:3000/your-route
```

Repeat for other routes or use the same path to append more records to the same cassette.

### How to run the CLI

**If you installed the package** (`npm install softprobe`):

```bash
npx softprobe diff <cassette.ndjson> <targetUrl>
```

**If you're in the repo** (no install, no build needed):

```bash
./bin/softprobe diff <cassette.ndjson> <targetUrl>
```

The `bin/softprobe` script uses the built CLI when present, otherwise runs from source.

### What the CLI does

1. Loads the cassette and finds the **inbound** HTTP record.
2. Sends the same method and path to `<targetUrl>` with these headers:
   - `x-softprobe-mode: REPLAY`
   - `x-softprobe-trace-id: <traceId from record>`
3. The target server must have **cassetteDirectory** set (e.g. via config) so it resolves the cassette as `{cassetteDirectory}/{traceId}.ndjson`. Compares the live response to the recording (the **diff reporter**). Writes **PASS** or **FAIL** to stderr; on failure, prints a colored diff of what differed. Writes the response body to stdout. Exit code 0 = pass, 1 = fail or error.

Your service must use Softprobe middleware (Express or Fastify) so it reads these headers and runs that request in replay context. See [design.md](design.md) for the full coordination flow.

### Example

```bash
# Start your app (with Softprobe middleware) on port 3000, then:
npx softprobe diff ./softprobe-cassettes.ndjson http://localhost:3000
# Or from repo: ./bin/softprobe diff ./softprobe-cassettes.ndjson http://localhost:3000
```

## More

- **Example app:** `examples/basic-app` — capture, replay, and custom matcher.
- **Example walkthrough:** [examples/basic-app/README.md](examples/basic-app/README.md)
- **Design index:** [design.md](design.md) — architecture, cassette format, and coordination headers.
- **Context design:** [design-context.md](design-context.md)
- **Cassette design:** [design-cassette.md](design-cassette.md)
- **Matcher design:** [design-matcher.md](design-matcher.md)
