# @softprobe/web-record

Browser session recording SDK. Captures DOM mutations with [rrweb](https://github.com/rrweb-io/rrweb)
and exports batches to Softprobe **thelake** via OTLP `POST {baseUrl}/v1/traces`.

## Install

```bash
npm install @softprobe/web-record
```

## Usage

```ts
import { RecordSdk } from "@softprobe/web-record";

const recorder = RecordSdk.init({
  publicKey: process.env.SOFTPROBE_PUBLIC_KEY!,
  baseUrl: process.env.SOFTPROBE_BASE_URL!,
  sessionId: openCodeSessionId, // becomes sp.session.id
  serviceName: "softprobe-code",
  maskAllInputs: true,
});

// When the chat session changes:
recorder.setSessionId(nextSessionId);

// On teardown:
recorder.stop();
```

Missing credentials soft-disable the SDK (warn + no-op) so hosts keep running.

## Session header

While recording is enabled, the SDK patches `fetch` / XHR to inject
`x-sp-session-id` on **same-origin** requests only (relative URLs and
`location.origin`). Third-party / CDN calls are left untouched.

## OTLP contract

Each flush emits one span:

| Field | Value |
|---|---|
| name | `softprobe.web.recording` |
| `sp.observation.type` | `recording` |
| `sp.session.id` | correlation id |
| `sp.recording.batch_index` | monotonic batch counter |
| event `sp.recording.batch` | attribute `sp.recording.events` = JSON rrweb events |

Auth: `Authorization: Bearer <publicKey>`.

Credentials and `{baseUrl}/v1/traces` derivation come from `@softprobe/tracing/config`
(same product semantics as the LLM SDK).
