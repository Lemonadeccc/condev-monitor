#!/usr/bin/env bash
set -euo pipefail

BASE_VERSION="${1:-${RELEASE_BASE_VERSION:-${npm_package_version:-0.0.0}}}"
STAMP="$(date +"%Y%m%d-%H%M%S")"

printf "%s-%s" "$BASE_VERSION" "$STAMP"
