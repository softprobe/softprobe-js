# @softprobe/web-record

Browser session recording and request tracing SDK.

## Install

```sh
npm install @softprobe/web-record
```

## Start capture

Initialize once when your app starts. The Agent API key is visible in browser code, so use an ingest-only key.

```ts
import { RecordSdk } from "@softprobe/web-record";

RecordSdk.init({
  apiKey: "<Agent API key>",
  baseUrl: "https://explorer.softprobe.ai/api/thelake",
  serviceName: "my-web-app",
  environment: "production",
  apiOrigins: ["https://api.example.com"],
  httpBodyCapture: {
    maxBodyBytes: 65536,
    routes: [
      {
        origin: "https://api.example.com",
        method: "POST",
        path: "/api/orders",
        redactJsonPaths: ["$.payment.cardNumber", "$.payment.cvv"],
      },
    ],
  },
});
```

The SDK creates a Session ID and keeps it in this tab across page loads. Set `sessionId` if your app already has a non-secret ID for the same user journey.

## Choose browser bodies

List each route by exact origin, method, and path. Its origin must also appear in `apiOrigins`. The SDK captures JSON bodies up to `maxBodyBytes`, replaces the configured JSON fields with `[REDACTED]`, and omits other content types and oversized bodies.

`apiOrigins` controls which API calls receive `traceparent` and `tracestate` headers. If the API has a different origin from the website, allow these headers in its CORS settings.

## Configure backend bodies

Browser body rules do not configure OBI. Add the backend and outgoing HTTP routes to OBI's native `payload_extraction` rules. Keep the default body action set to `exclude`, then include and redact the routes you need. See the [OBI Config v2 guide](https://opentelemetry.io/docs/zero-code/obi/configure/config-v2/) and [payload-capture limits](https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/blob/main/devdocs/features.md#payload-capture).

Input masking applies to the browser recording. It does not redact HTTP bodies. Use `redactJsonPaths` for browser bodies and OBI obfuscation rules for backend and outgoing bodies.
