# Browser telemetry architecture

## Goal

`@softprobe/web-record` captures rrweb recordings, standard browser HTTP spans, and optional route-scoped HTTP bodies. OpenTelemetry owns HTTP spans, context propagation, OTLP encoding, and export. Softprobe owns the product configuration, session value, recording behavior, and body privacy policy.

## Consumer boundary

The application imports only the Softprobe package:

```ts
import { RecordSdk } from "@softprobe/web-record";

const recorder = RecordSdk.init({
  apiKey: agentApiKey,
  httpBodyCapture: {
    routes: [{
      method: "POST",
      path: "/api/orders",
      redactJsonPaths: ["$.payment.billingPostcode"],
    }],
  },
});

recorder.setSessionId(nextSessionId);
await recorder.flush();
recorder.stop();
```

`@opentelemetry/api`, `@opentelemetry/browser-sdk`, `@opentelemetry/browser-instrumentation`, the official trace SDK, and OTLP exporter are runtime dependencies of `@softprobe/web-record`. Consumers do not import OTel packages or configure a provider, instrumentation, or exporter.

## OpenTelemetry API reuse

`RecordSdk.init()` is the Softprobe facade around the official OpenTelemetry browser API. It translates the package's stable, product-level options into OTel resources, trace processors, Fetch/XHR instrumentation, and an OTLP exporter. This keeps OTel's provider and package versions bundled and compatible while the application has one import and one initialization point.

| `RecordSdk.init()` option | OpenTelemetry setup |
| --- | --- |
| `serviceName` | Resource `service.name` |
| `environment` | Resource `deployment.environment.name` |
| `httpBodyCapture.routes` / `apiOrigins` | Official Fetch/XHR `ignoreUrls` and `propagateTraceHeaderCorsUrls` (defaults to `window.location.origin` plus route origins) |
| `apiKey`, `baseUrl` / `otlpEndpoint` | Official OTLP exporter endpoint and authorization header |
| generated or supplied session ID | Official session span processor; Softprobe adds `sp.session.id` for compatibility |
| `httpBodyCapture` | Softprobe extension, attached through official instrumentation hooks |

The SDK uses the OTel implementations for HTTP client spans, context propagation, session processing, batching, protobuf encoding, and export. Softprobe-specific behavior is limited to rrweb recording, the `sp.session.id` compatibility attribute, and opt-in HTTP body capture. OTel browser instrumentation does not capture payload bodies, so body capture is an extension rather than an OTel option. It attaches through the official Fetch request/completion hooks and the XHR completion hook; the XHR request observer only supplies route and request-body data because that instrumentation version has no request-body hook. The observer does not create HTTP spans or own propagation.

## Ownership and data flow

- `RecordSdk` resolves the Agent key and managed OTLP destination, persists the tab session ID, collects and masks rrweb events, applies route privacy rules, and exposes `record()`, `flush()`, `stop()`, and `setSessionId()`.
- `browser-runtime.ts` starts `startTracesSdk()` from `@opentelemetry/browser-sdk/traces`. It registers official `FetchInstrumentation` and `XhrInstrumentation` from `@opentelemetry/browser-instrumentation`, an official `SessionSpanProcessor`, the official HTTP/protobuf `OTLPTraceExporter`, and an official `BatchSpanProcessor`. It supplies the trace processors so `flush()` can retain the batch processor and call its `forceFlush()` directly; exporter failures already reject that promise and flow into the recorder's retry logic. The protobuf exporter matches TheLake's supported OTLP wire format.
- `resolveEffectiveOrigins` derives exact-origin filters from `window.location.origin` plus any origin declared on `httpBodyCapture.routes` (or from `apiOrigins` when explicitly provided). When `httpBodyCapture.routes` is configured, `resolveRouteAllowlistUrlSources` narrows `ignoreUrls` so OTel traces and injects W3C propagation headers only on matching route paths (supporting `*` single-segment and `**` multi-segment wildcards). OTel ignores requests outside selected origins/routes and ignores the configured collector endpoint. URL attributes omit query strings and fragments.
- The OTel session processor adds `session.id` when each span starts. A small Softprobe processor also writes `sp.session.id` as the existing Explorer compatibility attribute. The session provider reads the current tab session ID at span start, so an in-flight HTTP span keeps its original session.
- rrweb batches are internal OTel spans named `softprobe.web.recording` with `sp.observation.type=recording`, `sp.recording.batch_index`, and a `sp.recording.batch` event containing the batch. OTel generates IDs and encodes the OTLP payload.
- `SpanLifecycleProcessor` tracks active HTTP and body spans. `flush()` ends a pending rrweb batch, waits for already-started requests and body children, then calls the official batch processor's `forceFlush()`. `setSessionId()` drains that work before changing the provider's current value.

## HTTP body capture

`http-body-capture.ts` is the only custom network observer. It creates no HTTP spans and injects no headers.

- Fetch request bodies use OTel's `requestHook`, and child-span creation uses `applyCustomAttributesOnSpan`. OTel's request hook does not receive the original URL when `fetch` is called with a string and `RequestInit`, so a thin wrapper supplies only the current call's URL and method to that hook. It creates no spans and changes no request headers. The wrapper clones the response as soon as the official instrumentation returns it, before releasing the original `Response` to the application, then reads the clone asynchronously. This avoids waiting for body capture before returning the response.
- XHR has no official request-body hook. A narrow observer records `open`, content type, and `send` data for a configured route, then uses OTel's XHR `applyCustomAttributesOnSpan` completion hook to create the child. Official XHR instrumentation still owns the HTTP span and trace headers.
- A route matches by normalized origin, uppercased method, and exact path or `*` / `**` path wildcard. Relative paths default to `window.location.origin` (or `apiOrigins[0]` when a single `apiOrigins` override is passed); cross-origin routes can specify a full HTTP(S) URL in `path` or set `origin` on the route. Only JSON content is considered. The default cap is 64 KiB, with a 256 KiB maximum. Redaction runs before a body is attached to telemetry.
- Once the official HTTP span completes, the observer creates `softprobe.http.body.capture` as its child. It carries `http.request.body.content` and `http.response.body.content` only when valid, bounded, redacted JSON was captured; otherwise it marks capture as omitted. The child has the same trace and session IDs as its HTTP parent.

The child span is needed because the official instrumentation hooks are synchronous, while reading a Fetch response body completes asynchronously. The child preserves parentage without delaying the application's response or trying to modify an already-ended OTel HTTP span. The XHR path uses the same child-span shape so body capture has one consistent representation across Fetch and XHR.

## Removed implementation

`http-interceptor.ts` and the hand-built `otlp.ts` exporter are removed. There is one HTTP-span owner: the official OTel Fetch/XHR instrumentation. Trace IDs, propagation, semantic HTTP attributes, batching, OTLP protobuf encoding, and export come from OpenTelemetry.

## Tradeoffs

- The official browser packages currently use experimental package versions. `@softprobe/web-record` pins the browser SDK, instrumentation, OTel API, trace SDK, and exporter to compatible exact versions.
- Bodies appear on a child span so OTel's HTTP span stays owned by the official instrumentation. Explorer should display child spans with their parents.
- The official OTLP exporter uses `fetch` and requests keepalive delivery when browser payload-size and concurrency limits allow it. `pagehide` flushing still remains best-effort; upload status can report `incomplete` during navigation.
- On exporter failure, the SDK restores the rrweb event batch for retry. A transport failure can occur after a collector accepted data, so retrying that batch can produce a duplicate recording span, as with any ambiguous HTTP export result.

## References

- [OpenTelemetry Browser SDK](https://github.com/open-telemetry/opentelemetry-browser/tree/main/packages/sdk)
- [OpenTelemetry browser Fetch/XHR instrumentations](https://github.com/open-telemetry/opentelemetry-browser/tree/main/packages/instrumentation)
- [OpenTelemetry HTTP semantic conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/http/http-spans.md)
