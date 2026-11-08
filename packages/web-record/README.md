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
  serviceName: "my-web-app",
  apiOrigins: ["https://api.example.com"],
  httpBodyCapture: {
    routes: [
      { method: "POST", path: "/api/orders" },
    ],
  },
});
```

That call uploads traces to `https://explorer.softprobe.ai/api/thelake/v1/traces`. Pass `baseUrl` when the page must upload somewhere else. Local and staging tests do that. `environment` is an optional span attribute and does not choose the host.

```ts
RecordSdk.init({
  apiKey: "<Agent API key>",
  baseUrl: "http://127.0.0.1:18080/api/thelake",
  serviceName: "my-web-app",
  environment: "local",
  apiOrigins: ["http://127.0.0.1:18080"],
  httpBodyCapture: {
    routes: [
      { method: "POST", path: "/api/orders" },
    ],
  },
});
```

The SDK creates a Session ID and keeps it in this tab across page loads. Set `sessionId` if your app already has a non-secret ID for the same user journey.

## Choose browser bodies

List each route by exact method and path. When `apiOrigins` has one entry, omit `origin` on the route. When it has several, set `origin` on every route to one of those entries. A route that omits `origin` in that case captures no body.

The SDK captures JSON bodies up to 64 KiB. Pass `maxBodyBytes` to change that cap. It replaces `cardNumber`, `cvv`, `cvc`, `password`, and `secret` with `[REDACTED]` anywhere in the JSON, including inside arrays. `redactJsonPaths` adds exact object paths such as `$.payment.token`. One path the SDK cannot parse drops that route. Other content types and oversized bodies are omitted.

The captured JSON is stored on the client span as `http.request.body.content` and `http.response.body.content`. The span name is `HTTP` plus the method.

`apiOrigins` controls which API calls receive a `traceparent` header. If the API has a different origin from the website, allow that header in its CORS settings.

## Configure backend bodies

Browser body rules do not configure OBI. Add the backend and outgoing HTTP routes to OBI's native `payload_extraction` rules. Keep the default body action set to `exclude`, then include and redact the routes you need. See the [OBI Config v2 guide](https://opentelemetry.io/docs/zero-code/obi/configure/config-v2/) and [payload-capture limits](https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation/blob/main/devdocs/features.md#payload-capture).

Input masking applies to the browser recording. It does not redact HTTP bodies. Use `redactJsonPaths` for browser bodies and OBI obfuscation rules for backend and outgoing bodies.
