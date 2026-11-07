# @softprobe/web

Add one script tag to record a browser session and trace selected API calls. Use the Agent's ingest-only key. The script does not add a Session ID header to application requests.

```html
<script
  src="/js/softprobe-session.js"
  data-api-key="spk_..."
  data-base-url="https://explorer.softprobe.ai/api/thelake"
  data-api-origins="https://travel-api.example.com"
  data-environment="production"
  data-service-name="travel-ota-web"
  data-mask-all-inputs="true"
  data-mask-text-selector=".capture-private"
  data-block-selector="#payment-details"
  data-http-body-capture='{"maxBodyBytes":65536,"routes":[{"origin":"https://travel-api.example.com","method":"POST","path":"/api/flights/payandissue","redactJsonPaths":["$.paymentDetails.cardNumber","$.paymentDetails.cvv"]}]}'
></script>
```

Add this tag to the shared page layout before your app's scripts so it can see API calls from the start. Replace the example key and address with your Agent key and API origin. The Agent key permits ingestion only. `data-api-origins` is a comma-separated list of exact API origins allowed to receive trace headers. The SDK keeps one Session ID for this tab across page loads.

The recording and request tracing live in `@softprobe/web-record`. This package reads the settings from the script tag and boots the SDK. Legacy `data-public-key` tags remain supported for existing non-profile installations. The SDK flushes on `pagehide`; navigation uploads are best-effort.

## HTTP body capture

Browser bodies are disabled unless `data-http-body-capture` is present. Its JSON
value contains a byte limit and exact `{origin, method, path}` routes. The route
origin must also appear in `data-api-origins`. Only valid JSON request and
response bodies within the limit are exported; oversized, non-JSON, or
unreadable bodies are omitted. `redactJsonPaths` supports dotted JSONPath
properties such as `$.paymentDetails.cardNumber`; redact sensitive fields in
both browser and server capture policies. Input masking only affects rrweb and
does not redact HTTP span bodies.

Configure OBI separately. `bodyCapture.enabled` in Softprobe Agent capture
settings is not an OBI switch and does not update a running OBI process. With
OBI Config v2, set an HTTP buffer and enable its native enrichment rules. Keep
the default action excluded and allowlist the routes that need bodies:

```yaml
extensions:
  obi:
    capture:
      instrumentation:
        http:
          buffer_size: 65536
          payload_extraction:
            enabled: [enrichment]
            enrichment:
              policy:
                default_action:
                  headers: exclude
                  body: exclude
                obfuscation_string: "[REDACTED]"
              rules:
                - action: obfuscate
                  type: body
                  scope: request
                  match:
                    url_path_patterns: [/api/flights/payandissue]
                    methods: [POST]
                    obfuscation_json_paths:
                      - $.paymentDetails.cardNumber
                      - $.paymentDetails.cvv
                - action: include
                  type: body
                  scope: all
                  match:
                    url_path_patterns:
                      - /api/flights/search
                      - /api/flights/book
                      - /api/flights/payandissue
                      - /ndc/v21.3/airshopping
                      - /ndc/v21.3/offerprice
                      - /ndc/v21.3/ordercreate
                      - /ndc/v21.3/orderchange
                    methods: [POST]
```

The browser SDK policy applies only to browser client spans. OBI's policy
applies to instrumented server and HTTP client spans. Keep both policies
aligned with the routes you intend to inspect, use an exclude-by-default rule,
and verify redaction in Explorer before enabling production capture.
