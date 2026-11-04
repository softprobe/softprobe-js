# @softprobe/web

One script tag for application session capture. The Agent key is ingest-only and is shared with the OBI installation. The SDK records with rrweb and exports browser request spans labeled with the Session ID and trace ID. It does not add a Session ID or capture ID header to application requests.

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
></script>
```

Explorer's Agent setup should generate this tag. The Agent API key identifies the owning App and permits ingestion only. Put the tag before the app's own scripts. `data-api-origins` is a comma-separated list of exact origins allowed to receive W3C trace context.

The recording and request tracing live in `@softprobe/web-record`. This package reads the settings from the script tag and boots the SDK. Legacy `data-public-key` tags remain supported for existing non-profile installations. The SDK flushes on `pagehide`; navigation uploads are best-effort.
