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
