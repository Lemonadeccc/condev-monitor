#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

PROJECT_NAME="${PROJECT_NAME:-condev-monitor}"
COMPOSE_FILE="${COMPOSE_FILE:-.devcontainer/docker-compose.deply.yml}"
CLICKHOUSE_SERVICE="${CLICKHOUSE_SERVICE:-condev-monitor-clickhouse}"
SCHEMA_FILE="${SCHEMA_FILE:-.devcontainer/clickhouse/init/001_condev_monitor_schema.sql}"

docker_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
    return
  fi
  echo "Neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
}

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "Schema file not found: $SCHEMA_FILE" >&2
  exit 1
fi

container_id="$(docker_compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps -q "$CLICKHOUSE_SERVICE" 2>/dev/null | head -n 1 || true)"
if [ -z "$container_id" ]; then
  echo "ClickHouse container not found (project=$PROJECT_NAME service=$CLICKHOUSE_SERVICE compose=$COMPOSE_FILE)" >&2
  exit 1
fi

echo "Waiting for ClickHouse to be ready..."
tries=60
while [ "$tries" -gt 0 ]; do
  if docker exec "$container_id" clickhouse-client --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  tries=$((tries - 1))
  sleep 2
done

if [ "$tries" -le 0 ]; then
  echo "ClickHouse did not become ready in time." >&2
  exit 1
fi

echo "Initializing ClickHouse schema (idempotent)..."
docker exec -i "$container_id" clickhouse-client --multiquery < "$SCHEMA_FILE"

echo "Verifying tables..."
docker exec "$container_id" clickhouse-client --query "SHOW TABLES FROM lemonade" || true
