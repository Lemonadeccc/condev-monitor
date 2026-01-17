#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
project_dir="$(cd "$script_dir/.." && pwd -P)"

if [ -f "$project_dir/.env" ]; then
    set -a
    . "$project_dir/.env"
    set +a
fi

RELEASE="$(bash scripts/gen-release.sh)"

export VITE_MONITOR_RELEASE="$RELEASE"
export VITE_MONITOR_DIST="vanilla"

tsc
vite build

bash scripts/upload-sourcemaps.sh
