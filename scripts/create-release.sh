#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/create-release.sh [--bump patch|minor|major|prepatch|preminor|premajor|prerelease] [--set-version X.Y.Z] [--branch <branch>] [--dry-run]

Bumps package.json/package-lock.json version, commits, pushes branch, creates v* tag, pushes tag.
Example:
  scripts/create-release.sh --bump patch
  scripts/create-release.sh --set-version 2.1.0
  scripts/create-release.sh --bump minor --dry-run
EOF
}

DRY_RUN=0
BRANCH=""
BUMP=""
SET_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --branch)
      BRANCH="${2:-}"
      if [[ -z "${BRANCH}" ]]; then
        echo "Error: --branch requires a value."
        exit 1
      fi
      shift 2
      ;;
    --bump)
      BUMP="${2:-}"
      if [[ -z "${BUMP}" ]]; then
        echo "Error: --bump requires a value."
        exit 1
      fi
      shift 2
      ;;
    --set-version)
      SET_VERSION="${2:-}"
      if [[ -z "${SET_VERSION}" ]]; then
        echo "Error: --set-version requires a value."
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "Error: unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not in a git repository."
  exit 1
fi

if [[ -n "${BUMP}" && -n "${SET_VERSION}" ]]; then
  echo "Error: use either --bump or --set-version, not both."
  exit 1
fi

if [[ -z "${BUMP}" && -z "${SET_VERSION}" ]]; then
  BUMP="patch"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is dirty. Commit or stash changes before creating a release tag."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TARGET_BRANCH="${BRANCH:-${CURRENT_BRANCH}}"

if [[ "${CURRENT_BRANCH}" != "${TARGET_BRANCH}" ]]; then
  echo "Error: current branch is ${CURRENT_BRANCH}, expected ${TARGET_BRANCH}. Checkout the target branch first."
  exit 1
fi

OLD_VERSION="$(node -p "require('./package.json').version")"
if [[ -z "${OLD_VERSION}" || "${OLD_VERSION}" == "undefined" ]]; then
  echo "Error: could not read current version from package.json."
  exit 1
fi

if [[ -n "${SET_VERSION}" ]]; then
  NPM_VERSION_ARG="${SET_VERSION}"
else
  NPM_VERSION_ARG="${BUMP}"
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  if [[ -n "${SET_VERSION}" ]]; then
    DRY_NEW_VERSION="${SET_VERSION}"
  else
    DRY_NEW_VERSION="<from npm version ${NPM_VERSION_ARG}>"
  fi
  DRY_TAG="v${DRY_NEW_VERSION}"
  echo "[dry-run] npm version ${NPM_VERSION_ARG} --no-git-tag-version"
  echo "[dry-run] git add package.json package-lock.json"
  echo "[dry-run] git commit -m \"chore(release): bump to ${DRY_TAG}\""
  echo "[dry-run] git push origin ${TARGET_BRANCH}"
  echo "[dry-run] git tag -a ${DRY_TAG} -m \"release: ${DRY_TAG}\""
  echo "[dry-run] git push origin ${DRY_TAG}"
  exit 0
fi

npm version "${NPM_VERSION_ARG}" --no-git-tag-version

NEW_VERSION="$(node -p "require('./package.json').version")"
if [[ -z "${NEW_VERSION}" || "${NEW_VERSION}" == "undefined" ]]; then
  echo "Error: could not read new version from package.json."
  exit 1
fi

if [[ "${NEW_VERSION}" == "${OLD_VERSION}" ]]; then
  echo "Error: version did not change (${OLD_VERSION})."
  exit 1
fi

TAG="v${NEW_VERSION}"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "Error: local tag ${TAG} already exists."
  exit 1
fi

if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q .; then
  echo "Error: remote tag ${TAG} already exists on origin."
  exit 1
fi

git add package.json package-lock.json
git commit -m "chore(release): bump to ${TAG}"
git push origin "${TARGET_BRANCH}"
git tag -a "${TAG}" -m "release: ${TAG}"
git push origin "${TAG}"

echo "Release prepared: ${OLD_VERSION} -> ${NEW_VERSION}."
echo "Branch ${TARGET_BRANCH} pushed and tag ${TAG} pushed."
echo "GitHub Actions release workflow should start from this tag push."
