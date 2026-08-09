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
pnpm install
pnpm build
pnpm test
```

## Release

1. Create a GitHub release with tag `vX.Y.Z` (for example `v0.1.0`).
2. [`.github/workflows/npm-publish.yml`](.github/workflows/npm-publish.yml) publishes all packages via npm Trusted Publishing (OIDC).

Requires Trusted Publisher on each package pointing at this repo and workflow `npm-publish.yml`.
