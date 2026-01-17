#!/usr/bin/env bash
set -euo pipefail

APP_ID="${MONITOR_APP_ID:-${APP_ID:-}}"
TOKEN="${MONITOR_TOKEN:-${SOURCEMAP_TOKEN:-${MONITOR_SOURCEMAP_TOKEN:-}}}"
RELEASE="${MONITOR_RELEASE:-${VITE_MONITOR_RELEASE:-}}"
DIST="${MONITOR_DIST:-${VITE_MONITOR_DIST:-}}"
PUBLIC_URL="${MONITOR_PUBLIC_URL:-}"
API_URL="${MONITOR_API_URL:-http://localhost:8081}"
DIST_DIR="${MONITOR_DIST_DIR:-dist}"

if [ -z "$APP_ID" ] || [ -z "$TOKEN" ] || [ -z "$RELEASE" ] || [ -z "$PUBLIC_URL" ]; then
    echo "Missing required env: MONITOR_APP_ID, MONITOR_TOKEN/SOURCEMAP_TOKEN, MONITOR_RELEASE/VITE_MONITOR_RELEASE, MONITOR_PUBLIC_URL" >&2
    exit 1
fi

if [ ! -d "$DIST_DIR" ]; then
    echo "Dist directory not found: $DIST_DIR" >&2
    exit 1
fi

case "$PUBLIC_URL" in
    */) ;;
    *) PUBLIC_URL="${PUBLIC_URL}/" ;;
esac

dist_dir_abs="$(cd "$DIST_DIR" && pwd -P)"

uploaded_any=0

while IFS= read -r -d '' map_path; do
    uploaded_any=1

    map_dir_abs="$(cd "$(dirname "$map_path")" && pwd -P)"
    map_abs="${map_dir_abs}/$(basename "$map_path")"
    minified_abs="${map_abs%.map}"
    rel_path="${minified_abs#"$dist_dir_abs"/}"
    minified_url="${PUBLIC_URL}${rel_path}"

    tmp_response="$(mktemp)"
    curl_args=(
        -sS
        -o "$tmp_response"
        -w "%{http_code}"
        -X POST
        "${API_URL%/}/api/sourcemap/upload"
        -H "X-Sourcemap-Token: ${TOKEN}"
        -F "appId=${APP_ID}"
        -F "release=${RELEASE}"
        -F "minifiedUrl=${minified_url}"
        -F "file=@${map_abs}"
    )
    if [ -n "$DIST" ]; then
        curl_args+=(-F "dist=${DIST}")
    fi

    http_code="$(curl "${curl_args[@]}")"

    if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
        echo "Upload failed for ${map_abs} (${http_code})" >&2
        cat "$tmp_response" >&2
        rm -f "$tmp_response"
        exit 1
    fi

    rm -f "$tmp_response"
    rm -f "$map_abs"
    echo "Uploaded and removed: ${map_abs}"
done < <(find "$DIST_DIR" -type f -name "*.js.map" -print0)

if [ "$uploaded_any" -eq 0 ]; then
    echo "No .js.map files found under ${DIST_DIR}"
fi
