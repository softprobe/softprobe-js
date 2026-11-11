# SDK release feature map

This repository has one release workflow. A published GitHub Release publishes
all five workspaces; `@softprobe/web-record` is included in that release, not
released independently.

| User-visible result | Implementation | Evidence to check |
| --- | --- | --- |
| A published GitHub Release starts the release | `.github/workflows/release.yml` trigger: `release.published` | Workflow run is associated with the requested release tag |
| The tag sets a consistent version | `Validate and extract version` and `Set package versions` in `release.yml` | Tag is `vX.Y.Z`; the publish logs show that version for every package |
| These five packages are published | `packages/tracing`, `packages/langchain`, `packages/vercel-ai-sdk`, `packages/opencode-plugin`, `packages/web-record` in `release.yml` | Each package has the release version in npm |
| Dependent SDKs install the matching core SDK | `Set package versions` pins `@softprobe/tracing` to the release version; publish order starts with tracing | Published package metadata declares the same `@softprobe/tracing` version |
| The browser session recorder ships as one package | `packages/web-record/package.json`; there is no `packages/web` workspace | `@softprobe/web-record` tarball and npm metadata exist; no `@softprobe/web` publish step exists |
| Production browser setup omits the ingest URL and origin list | `resolveInitBaseUrl` in `packages/web-record/src/sdk.ts`; `resolveEffectiveOrigins` in `packages/web-record/src/http-body-capture.ts` | An init without `baseUrl` posts to `https://explorer.softprobe.ai/api/thelake/v1/traces`; an init without `apiOrigins` traces `window.location.origin` plus any origin declared on `httpBodyCapture.routes` |
| Minimal browser init captures redacted same-origin JSON bodies and adopts host session IDs by default | `RecordSdk.init` and `discoverHostSessionId` in `packages/web-record/src/sdk.ts`; `resolveBodyCaptureRoutes` and `installHttpBodyCapture` in `packages/web-record/src/http-body-capture.ts` | An init with only `apiKey` captures redacted same-origin JSON bodies up to 64 KiB on `softprobe.http.body.capture` and adopts session IDs from `sessionStorage`, `/sessions/:id` paths, and `/sessions` JSON responses |
| Pre-bundled browser script auto-initializes from `<script data-api-key="...">` | `autoInitFromScript` in `packages/web-record/src/browser.ts`; `dist/browser.js` in `packages/web-record/package.json` | `dist/browser.js` is built into the package and calls `RecordSdk.init` when loaded from a `<script data-api-key="...">` element |
| Vercel AI integration maps operation spans to `agent`, automatically extracts incoming HTTP `traceparent` and `session.id`, falls back to `trace_id` on standalone calls, and supports one-call init | `createSoftprobeObservationAttributes`, `installIncomingHttpContextPropagation`, and `initVercelAiTelemetry` in `packages/vercel-ai-sdk/src/integration.ts`; `SoftprobeClient` in `packages/tracing/src/client.ts` | Top-level operation spans emit `sp.observation.type="agent"` and `session.id` / `sp.session.id` / `gen_ai.conversation.id` from incoming HTTP headers/routes, `runtimeContext`, or standalone `traceId`; `SoftprobeClient` accepts `apiKey` and defaults `baseUrl` to `https://explorer.softprobe.ai/api/thelake` |
| npm verifies the GitHub workflow identity | `permissions.id-token: write`; npm Trusted Publishing; no `NODE_AUTH_TOKEN` or `setup-node` `registry-url` | Successful publish logs show npm provenance; no token is added to the job |
| `main` records the released versions | `Sync package versions to main` in `release.yml` | A workflow commit sets all five package versions and restores dependency ranges to `*` |

## Package set

| Workspace | npm package | Published by release workflow |
| --- | --- | --- |
| `packages/tracing` | `@softprobe/tracing` | Yes; first |
| `packages/langchain` | `@softprobe/langchain` | Yes |
| `packages/vercel-ai-sdk` | `@softprobe/vercel-ai-sdk` | Yes |
| `packages/opencode-plugin` | `@softprobe/opencode-plugin` | Yes |
| `packages/web-record` | `@softprobe/web-record` | Yes; last |

The former `packages/web` workspace was removed in PR #17. Do not restore it
to the publish loop: the v0.1.8 workflow published the five packages above,
then failed with `ENEEDAUTH` when it tried to publish the removed package.
