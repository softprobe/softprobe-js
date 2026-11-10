# @softprobe/web-record

Record browser activity and trace same-origin API calls with automatic JSON body capture and session correlation.

## Install

```sh
npm install @softprobe/web-record
```

The package includes the OpenTelemetry browser SDK, its Fetch and XHR instrumentations, and the OTLP exporter as dependencies. Import `RecordSdk` from `@softprobe/web-record`. Your app does not need to import or configure OpenTelemetry.

## Start capture

Initialize the SDK once in your browser entrypoint:

```ts
import { RecordSdk } from "@softprobe/web-record";

RecordSdk.init({
  apiKey: "<Agent API key>",
});
```

Or add a single `<script>` tag to `<head>` in plain HTML pages:

```html
<script
  src="https://unpkg.com/@softprobe/web-record/dist/browser.js"
  data-api-key="<Agent API key>"
  defer
></script>
```

With only `apiKey`, `RecordSdk.init()` enables these defaults:

- Exports OTLP traces and rrweb DOM recordings to `https://explorer.softprobe.ai/api/thelake/v1/traces` (`baseUrl` overrides this for local or staging deployments).
- Traces same-origin `fetch` and `XMLHttpRequest` calls (`window.location.origin`) and injects W3C `traceparent` and `tracestate` headers.
- Captures same-origin JSON request and response bodies up to 64 KiB and replaces `cardNumber`, `cvv`, `cvc`, `password`, and `secret` with `[REDACTED]`.
- Masks all browser input elements (`maskAllInputs: true`).
- Adopts application session IDs automatically from `sessionStorage`, `/sessions/:id` request paths, or `/sessions` JSON responses when `sessionId` is omitted.

Replace `<Agent API key>` with an ingest-only Agent API key (`spk_...`). The key is visible in browser code, so never use a user password, cookie, or account token.

## Optional route filtering and custom redaction

Pass `httpBodyCapture: { routes: [...] }` when you want to restrict JSON body capture to specific routes or redact custom JSONPath fields. Pass `httpBodyCapture: false` to disable HTTP body capture.

```ts
import { RecordSdk } from "@softprobe/web-record";

RecordSdk.init({
  apiKey: "<Agent API key>",
  serviceName: "travel-ota-web",
  httpBodyCapture: {
    routes: [
      { method: "POST", path: "/api/flights/search" },
      { method: "POST", path: "/api/flights/book" },
      { method: "POST", path: "/api/flights/payandissue", redactJsonPaths: ["$.payment.billingTaxId"] },
    ],
  },
});
```

Add each route by exact method and path (relative path such as `"/api/flights/search"` or full URL such as `"https://api.example.com/api/checkout"`). The SDK captures JSON bodies up to 64 KiB (`maxBodyBytes` changes that cap). It replaces `cardNumber`, `cvv`, `cvc`, `password`, and `secret` with `[REDACTED]` anywhere in the JSON, including inside arrays. Use `redactJsonPaths` for any other exact object path.

Captured bodies are exported on a child span named `softprobe.http.body.capture`. OpenTelemetry owns the HTTP client span and the Softprobe child carries only the bounded JSON body after redaction. The response is returned to your app without waiting for body capture to finish.

## Configure backend bodies

Browser body rules do not configure OBI. Add the same backend and outgoing routes to OBI's native `payload_extraction` rules. Keep the default body action set to `exclude`, then use `include` and `obfuscate` rules for selected routes. See the [OBI Config v2 guide](https://opentelemetry.io/docs/zero-code/obi/configure/config-v2/) and [OBI payload-capture limits](https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/blob/main/devdocs/features.md#payload-capture).

Input masking applies to the browser recording. It does not redact HTTP body fields. Use `redactJsonPaths` for browser request bodies and OBI obfuscation rules for backend and outgoing request bodies.
