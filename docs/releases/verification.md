# Release verification checklist

Use this checklist for each SDK release. Save the tag, workflow URL, registry
versions, and `main` sync commit in the release record or final report.

Set `VERSION` to the version being released:

```sh
VERSION=0.1.9 # update this value when checking a later release
TAG="v$VERSION"
```

## Before publishing

- [ ] The release commit is on `main`; its required checks passed.
- [ ] The requested version is absent from GitHub tags/releases and from every
      package in the release set.
- [ ] `.github/workflows/release.yml` still lists the five packages in the
      feature map and has no extra publish target.
- [ ] The intended merged `main` commit has been recorded as the tag target.

Check that the tag does not exist and record the current `main` commit before
publishing:

```sh
git ls-remote --tags origin "refs/tags/$TAG"
git fetch origin main
git log -1 --oneline origin/main
for package in @softprobe/tracing @softprobe/langchain @softprobe/vercel-ai-sdk @softprobe/opencode-plugin @softprobe/web-record; do npm view "$package" versions --json; done
```

The first command must print no tag ref. Review each package's version list
and confirm `VERSION` is unused before creating the release.

## After publishing

- [ ] The workflow run for the tag completed successfully.
- [ ] The GitHub Release tag points to the intended merged `main` commit.
- [ ] npm reports the new version for each package in the feature map.
- [ ] Published dependent package metadata pins
      `@softprobe/tracing` to the same release version.
- [ ] The `@softprobe/web-record` tarball is available from npm and contains
      the package built from that tag.
- [ ] The release workflow's version-sync commit is present on `main`, with all
      five manifests at the release version and their tracing dependencies set
      back to `*`.

Check the run and registry after it completes:

```sh
gh release view "$TAG" --json tagName,isDraft,isPrerelease,targetCommitish
git fetch origin --tags
git rev-parse "$TAG^{commit}"
gh run list --workflow release.yml --branch "$TAG" --limit 5
for package in @softprobe/tracing @softprobe/langchain @softprobe/vercel-ai-sdk @softprobe/opencode-plugin @softprobe/web-record; do npm view "$package@$VERSION" version; done
npm view "@softprobe/web-record@$VERSION" dist.tarball dist.integrity dependencies --json
```

Use the successful workflow URL from `gh run list` to inspect the publish and
version-sync logs. Confirm the `main` sync commit in that run, then inspect
the five `package.json` files at `origin/main` for the matching version and
the dependent packages' `@softprobe/tracing` range `*`.

## If publishing fails

The workflow publishes packages sequentially and npm does not allow replacing
an already published version. Record which packages reached npm, inspect the
failed step and registry state, and stop before retrying or creating another
release. Resolve the partial release deliberately; never assume a failed
workflow means nothing was published.
