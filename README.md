# softprobe-js

TypeScript/Node SDKs for [Softprobe](https://softprobe.ai) LLM observability.

In the Softprobe workspace this repo is the sibling checkout `softprobe-js/`
(next to `sp-llm/` and `thelake/`). Language-neutral contracts stay in `sp-llm`.

## Packages

| Package | Description |
| --- | --- |
| [`@softprobe/tracing`](packages/tracing) | Core Softprobe tracing SDK |
| [`@softprobe/langchain`](packages/langchain) | LangChain callback handler |
| [`@softprobe/vercel-ai-sdk`](packages/vercel-ai-sdk) | Vercel AI SDK telemetry |
| [`@softprobe/opencode-plugin`](packages/opencode-plugin) | OpenCode coding-agent plugin |

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

Requires a Trusted Publisher on **each** package pointing at this repo and
workflow filename exactly `release.yml` (case-sensitive). Configurations
created after 2026-05-20 must also allow the publish action.
