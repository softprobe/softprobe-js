# @softprobe/web-record

Record browser activity and trace selected API calls. The SDK can capture JSON request and response bodies for routes you list.

## Install

```sh
npm install @softprobe/web-record
```

The package includes the OpenTelemetry browser SDK, its Fetch/XHR instrumentations, and OTLP exporter as dependencies. Import `RecordSdk` from `@softprobe/web-record`; your app does not need to import or configure OpenTelemetry.

`RecordSdk.init()` configures those official OpenTelemetry components for the app. OpenTelemetry creates and exports the HTTP spans. Softprobe adds only rrweb recording, the `sp.session.id` compatibility attribute, and optional route-scoped body capture. Body capture uses the instrumentation hooks and requires the `httpBodyCapture` extension because OpenTelemetry's browser instrumentations do not capture payloads.

## Start capture

Initialize the SDK once when your app starts. For a site that loads a new page on navigation, add the setup to the shared page layout.

```ts
import { RecordSdk } from "@softprobe/web-record";

RecordSdk.init({
  apiKey: "<Agent API key>",
  serviceName: "travel-ota-web",
  apiOrigins: ["https://travel.example.com"],
  httpBodyCapture: {
    routes: [
      { method: "POST", path: "/api/flights/search" },
      { method: "POST", path: "/api/flights/book" },
      { method: "POST", path: "/api/flights/payandissue" },
    ],
  },
});
```

That call uploads to `https://explorer.softprobe.ai/api/thelake/v1/traces`. Pass `baseUrl` when the page must upload to a local or staging Explorer. `environment` is an optional span attribute and does not choose the host.

Replace the example Agent API key and website address with your values. Use an Agent ingest key. The key is visible in browser code, so do not use a user password, cookie, or account token.

The SDK creates a Session ID and keeps it in this tab across page loads. Set `sessionId` if your app already has a non-secret ID for the user journey.

Browser spans carry the OpenTelemetry `session.id` attribute and Softprobe's `sp.session.id` compatibility attribute with the same value. If you change the ID with `setSessionId()`, the SDK drains in-flight work before switching both attributes.

## Choose browser bodies

Add each route by exact method and path. When `apiOrigins` has one entry, omit `origin` on the route. When it has several, set `origin` on every route to one of those entries. The SDK captures JSON bodies up to 64 KiB. Pass `maxBodyBytes` to change that cap. It replaces `cardNumber`, `cvv`, `cvc`, `password`, and `secret` with `[REDACTED]` anywhere in the JSON, including inside arrays. Use `redactJsonPaths` for any other exact object path. It omits other content types and bodies over the limit.

`apiOrigins` is an exact-origin allowlist for browser HTTP spans and `traceparent` / `tracestate` propagation. Requests to other origins, including subdomains, are ignored. If your API uses a different origin from the website, allow those headers in the API's CORS settings.

Captured bodies are exported on a child span named `softprobe.http.body.capture`. OpenTelemetry owns the HTTP client span and the Softprobe child carries only the route-approved, bounded JSON body after redaction. The response is returned to your app without waiting for body capture to finish.

## Configure backend bodies

Browser body rules do not configure OBI. Add the same backend and outgoing routes to OBI's native `payload_extraction` rules. Keep the default body action set to `exclude`, then use `include` and `obfuscate` rules for selected routes. See the [OBI Config v2 guide](https://opentelemetry.io/docs/zero-code/obi/configure/config-v2/) and [OBI payload-capture limits](https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/blob/main/devdocs/features.md#payload-capture).

Input masking applies to the browser recording. It does not redact HTTP body fields. Use `redactJsonPaths` for browser request bodies and OBI obfuscation rules for backend and outgoing request bodies.
