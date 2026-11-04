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
  apiKey: process.env.SOFTPROBE_API_KEY!, // existing Agent ingest-only key
  baseUrl: process.env.SOFTPROBE_BASE_URL!,
  captureId: process.env.SOFTPROBE_CAPTURE_ID!, // non-secret profile id
  apiOrigins: ["https://travel-api.example.com"], // exact origins to trace
  sessionId: openCodeSessionId, // becomes sp.session.id
  serviceName: "softprobe-code",
  maskAllInputs: true,
  onUploadStatus: (status) => showCaptureStatus(status),
});

// When the chat session changes:
recorder.setSessionId(nextSessionId);

// On teardown:
recorder.stop();
```

Missing credentials soft-disable the SDK (warn + no-op) so hosts keep running.

Inputs are masked by default. Use `maskTextSelector` for visible text that should
be masked and `blockSelector` for page regions that must not be recorded. These
selectors are separate from server-side API payload redaction; inspect a sample
recording before enabling production capture.

The SDK does not add a session ID header to application requests. Browser
request spans carry the session and capture IDs; W3C trace context is sent only
to the exact API origins listed in `apiOrigins`.

## Browser request tracing

When `apiOrigins` is set, the SDK emits a client span for each `fetch` or XHR
request to those exact HTTP(S) origins and injects its matching `traceparent`
(and `tracestate` when supplied) only there. It records the URL path without the
query string or request/response bodies. Configure CORS on each selected API to
allow the trace headers, or route requests through the app's same-origin gateway.
Do not enable this alongside another browser fetch/XHR instrumentation unless
that instrumentation is configured to avoid duplicate client spans.

When the SDK generates a session ID, it stores it in `sessionStorage` scoped by
capture ID (or service name for legacy setup), so full-page navigation in the
same tab continues the session. A supplied application session ID takes priority.

## Navigation and upload status

The SDK attempts a `fetch` with `keepalive: true` when the page fires `pagehide`.
This is best-effort: browsers may still terminate the page or reject an oversized
keepalive body. `uploadStatus` and `onUploadStatus` report `idle`, `pending`,
`uploaded`, `failed`, or `incomplete`; applications can show that recording may
not have finished uploading. Do not treat a pagehide attempt as a durable flush.

## OTLP contract

Each flush emits one span:

| Field | Value |
|---|---|
| name | `softprobe.web.recording` |
| `sp.observation.type` | `recording` |
| `sp.session.id` | correlation id |
| `sp.capture.id` | non-secret capture profile id, when configured |
| `sp.recording.batch_index` | monotonic batch counter |
| event `sp.recording.batch` | attribute `sp.recording.events` = JSON rrweb events |

Auth: `Authorization: Bearer <apiKey>`. `publicKey` remains accepted for older
integrations; new Agent capture setup should pass `apiKey`.

Credentials and `{baseUrl}/v1/traces` derivation come from `@softprobe/tracing/config`
(same product semantics as the LLM SDK).

When `captureId` is configured, exports also send it as
`X-Softprobe-Capture-ID` to the Softprobe ingest endpoint so Explorer can
validate Agent/profile ownership before signing the internal ingest assertion.
The SDK never sends this header to the application's API.
