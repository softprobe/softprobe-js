# softprobe-js

TypeScript/Node SDKs for [Softprobe](https://softprobe.ai) LLM observability.

This repository is part of the Softprobe Blackbox ecosystem alongside public sibling repositories [`softprobe/explorer`](https://github.com/softprobe/explorer) and [`softprobe/thelake`](https://github.com/softprobe/thelake). Language-neutral telemetry contracts live in [`softprobe/explorer`](https://github.com/softprobe/explorer).

## Packages

| Package | Description |
| --- | --- |
| [`@softprobe/tracing`](packages/tracing) | Core Softprobe tracing SDK |
| [`@softprobe/langchain`](packages/langchain) | LangChain callback handler |
| [`@softprobe/vercel-ai-sdk`](packages/vercel-ai-sdk) | Vercel AI SDK telemetry |
| [`@softprobe/opencode-plugin`](packages/opencode-plugin) | OpenCode coding-agent plugin |
| [`@softprobe/opencode-blackbox`](packages/opencode-blackbox) | OpenCode plugin for Softprobe Blackbox |
| [`@softprobe/web-record`](packages/web-record) | Browser session recording (rrweb → OTLP) |

## Examples

Runnable samples that follow the public Agent QA docs:

- [`examples/basic`](examples/basic) — `SoftprobeClient.fromEnv()`
- [`examples/langchain`](examples/langchain) — env auto / `instrument()` + app `thread_id`

Python: [`softprobe/softprobe-py` examples](https://github.com/softprobe/softprobe-py/tree/main/examples).

See [`examples/README.md`](examples/README.md). Docs: [LangChain install](https://docs.softprobe.ai/en/agent-qa/langchain).

## Develop

```bash
npm install
npm run build
npm test
```

## Release

1. Create a GitHub release with tag `vX.Y.Z` (for example `v0.1.0`).
2. [`.github/workflows/release.yml`](.github/workflows/release.yml) publishes
   all packages via npm Trusted Publishing (OIDC) — no npm token.

For the package map and release verification checklist, see
[`docs/releases/feature-map.md`](docs/releases/feature-map.md) and
[`docs/releases/verification.md`](docs/releases/verification.md).

Requires a Trusted Publisher on **each** package pointing at this repo and
workflow filename exactly `release.yml` (case-sensitive). Configurations
created after 2026-05-20 must also allow the publish action.
