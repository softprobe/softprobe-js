# @softprobe/web

One script tag for a browser app. It records the page with rrweb and sends batches to Softprobe, and it sets `x-sp-session-id` on same-origin `fetch` and `XMLHttpRequest` calls. Both use the id stored in `sessionStorage` under `x-sp-session-id`.

```html
<script
  src="/js/softprobe-session.js"
  data-base-url="http://10.0.0.170:30091"
  data-public-key="home-demo"
></script>
```

`data-base-url` is the TheLake origin. Recording posts to `{data-base-url}/v1/traces`. `data-public-key` is the bearer token that origin already accepts. Put the tag before the app's own scripts.

The recording and header behavior lives in `@softprobe/web-record`. This package only boots it.
