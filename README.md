# Softprobe

Topology-aware record & replay testing framework for Node.js via OpenTelemetry. Record real traffic (Postgres, Redis, HTTP) into NDJSON cassettes and replay it in tests without live dependencies.

## Installation

```bash
npm install @softprobe/softprobe-js
```

## Global CLI (Recommended)

Install once, then use `softprobe` directly:

```bash
npm install -g @softprobe/softprobe-js
softprobe --help
softprobe --version
```

Fallback (no global install):

```bash
npx @softprobe/softprobe-js --help
```

## Quick Start (Library + CLI)

1. Install and add an instrumentation bootstrap that imports Softprobe first:

```ts
// instrumentation.ts
import "@softprobe/softprobe-js/init";

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
```

2. Start your service with that bootstrap:

```bash
node -r ./instrumentation.ts ./server.ts
```

3. Capture a real request as a cassette:

```bash
TRACE_ID=11111111111111111111111111111111
softprobe capture "http://localhost:3000/your-route" --trace-id "${TRACE_ID}"
```

4. Replay in tests with `run({ mode, storage, traceId }, fn)`:

```ts
import { softprobe } from "@softprobe/softprobe-js";

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

5. Compare current behavior vs recorded behavior with CLI diff:

```bash
softprobe diff ./cassettes/11111111111111111111111111111111.ndjson http://localhost:3000
```

For a full walkthrough, see [examples/basic-app/README.md](examples/basic-app/README.md) and [examples/pricing-regression-demo/README.md](examples/pricing-regression-demo/README.md).

## CLI — `softprobe capture` and `softprobe diff`

Use `softprobe capture` to record via HTTP headers, and `softprobe diff` to replay + compare.

### Capture usage

```bash
softprobe capture <url> --trace-id <traceId> [--method <METHOD>] [--data <body>] [--header <k:v> ...] [--output <file>]
```

`softprobe capture` invokes `curl` and always sends:

- `x-softprobe-mode: CAPTURE`
- `x-softprobe-trace-id: <traceId>`

Example:

```bash
softprobe capture "http://localhost:3000/orders/42" \
  --trace-id 11111111111111111111111111111111 \
  --method POST \
  --header "content-type: application/json" \
  --data '{"quantity":2}'
```

This confirms: yes, capture mode can be turned on by HTTP headers, and this command standardizes it.

### Diff usage

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

**Global install (recommended):**

```bash
softprobe diff <cassette.ndjson> <targetUrl>
```

**No global install (fallback):**

```bash
npx @softprobe/softprobe-js diff <cassette.ndjson> <targetUrl>
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
softprobe diff ./softprobe-cassettes.ndjson http://localhost:3000
# Fallback:
npx @softprobe/softprobe-js diff ./softprobe-cassettes.ndjson http://localhost:3000
# Or from repo: ./bin/softprobe diff ./softprobe-cassettes.ndjson http://localhost:3000
```

## Release

This repository publishes to npm as `@softprobe/softprobe-js` via GitHub Actions workflow [`.github/workflows/release.yml`](.github/workflows/release.yml).

Setup once:

1. Configure npm Trusted Publishing for this package and this GitHub repository/workflow.
2. Ensure npm package access is public for the scoped package.
3. Keep workflow permissions with `id-token: write` (already set in release workflow).

Reference:
- npm trusted publishing docs: https://docs.npmjs.com/trusted-publishers/
- npm classic token revocation announcement: https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/

Release flow:

1. Merge changes to `main`.
2. Create and push a version tag, for example `v2.0.1`.
3. GitHub Action builds and publishes automatically.

Manual validation flow:

1. Run the `Release` workflow with `dry_run=true` to verify publish steps without publishing.

No `NPM_TOKEN` repository secret is required for this workflow.

## Cursor Skills

This repo ships a ready-to-use Cursor Skill at:

- `cursor-skills/softprobe/SKILL.md`
- `cursor-skills/softprobe/docs/softprobe-spec.md`
- `cursor-skills/softprobe/docs/architecture-contract.md`
- `cursor-skills/softprobe/docs/workflow-contract.md`
- `cursor-skills/softprobe/docs/compatibility-matrix.md`
- `cursor-skills/softprobe/docs/do-not-infer.md`
- `cursor-skills/softprobe/templates/capture.sh`
- `cursor-skills/softprobe/templates/diff.sh`
- `cursor-skills/softprobe/templates/demo-pricing.sh`

For external repositories, install/copy the entire `cursor-skills/softprobe` folder so the skill includes both instructions and product knowledge.

### Install into Cursor

1. Open Cursor Settings.
2. Open Skills management.
3. Add/import the skill from this repo path: `cursor-skills/softprobe`.
   - If importing to another repo, copy the full folder (including `docs/` and `templates/`).
4. Ensure global CLI is installed: `npm install -g @softprobe/softprobe-js`.
5. Reload Cursor window.

### Use in Cursor

1. Ask Cursor to run the Softprobe skill workflow.
2. Provide `TARGET_URL`, `ROUTE`, `TRACE_ID`, and cassette directory.
3. Use the templates directly or let Cursor fill them in:
   - capture: `templates/capture.sh`
   - replay compare: `templates/diff.sh`
   - demo flow: `templates/demo-pricing.sh`

## Package Layout

- `src/core` contains shared framework-agnostic contracts and runtime helpers.
- `src/instrumentations/<package>` contains package-specific hooks/patches (for example `express`, `fastify`, `redis`, `postgres`, `fetch`).
- `src/instrumentations/common` contains shared protocol helpers used by multiple instrumentation packages.

## More

- **Example app:** `examples/basic-app` — capture, replay, and custom matcher.
- **Example walkthrough:** [examples/basic-app/README.md](examples/basic-app/README.md)
- **Design index:** [design.md](design.md) — architecture, cassette format, and coordination headers.
- **Context design:** [design-context.md](design-context.md)
- **Cassette design:** [design-cassette.md](design-cassette.md)
- **Matcher design:** [design-matcher.md](design-matcher.md)
