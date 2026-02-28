#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/create-release.sh [--dry-run]

Creates and pushes a release tag from package.json version.
Example:
  scripts/create-release.sh
  scripts/create-release.sh --dry-run
EOF
}

DRY_RUN=0
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required."
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
if [[ -z "${VERSION}" || "${VERSION}" == "undefined" ]]; then
  echo "Error: could not read version from package.json."
  exit 1
fi

TAG="v${VERSION}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not in a git repository."
  exit 1
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] git tag -a ${TAG} -m \"release: ${TAG}\""
  echo "[dry-run] git push origin ${TAG}"
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is dirty. Commit or stash changes before creating a release tag."
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "Error: local tag ${TAG} already exists."
  exit 1
fi

if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q .; then
  echo "Error: remote tag ${TAG} already exists on origin."
  exit 1
fi

git tag -a "${TAG}" -m "release: ${TAG}"
git push origin "${TAG}"

echo "Created and pushed release tag ${TAG}."
echo "GitHub Actions release workflow should start from this tag push."
