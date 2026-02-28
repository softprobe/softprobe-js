#!/usr/bin/env bash
set -euo pipefail

# Usage:
# TRACE_ID=11111111111111111111111111111111 \
# CASSETTE_DIR=./cassettes \
# TARGET_URL=http://127.0.0.1:3000 \
# bash templates/diff.sh

: "${TRACE_ID:?TRACE_ID is required}"
: "${CASSETTE_DIR:?CASSETTE_DIR is required}"
: "${TARGET_URL:?TARGET_URL is required}"

CASSETTE_PATH="${CASSETTE_DIR}/${TRACE_ID}.ndjson"
softprobe diff "$CASSETTE_PATH" "$TARGET_URL"
