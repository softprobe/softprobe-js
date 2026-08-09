# softprobe-js

TypeScript/Node SDKs for [Softprobe](https://softprobe.ai) LLM observability.

## Packages

| Package | Description |
| --- | --- |
| [`@softprobe/tracing`](packages/tracing) | Core Softprobe tracing SDK |
| [`@softprobe/langchain`](packages/langchain) | LangChain callback handler |
| [`@softprobe/vercel-ai-sdk`](packages/vercel-ai-sdk) | Vercel AI SDK telemetry |
| [`@softprobe/opencode-plugin`](packages/opencode-plugin) | OpenCode coding-agent plugin |

## Develop

```bash
pnpm install
pnpm build
pnpm test
```

## Release

1. Create a GitHub release with tag `vX.Y.Z` (for example `v0.1.0`).
2. [`.github/workflows/release.yml`](.github/workflows/release.yml) publishes
   all packages via npm Trusted Publishing (OIDC) — no npm token.

Requires a Trusted Publisher on **each** package pointing at this repo and
workflow filename exactly `release.yml` (case-sensitive). Configurations
created after 2026-05-20 must also allow the publish action.
