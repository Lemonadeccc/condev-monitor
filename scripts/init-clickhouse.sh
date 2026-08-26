#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

PROJECT_NAME="${PROJECT_NAME:-condev-monitor}"
COMPOSE_FILE="${COMPOSE_FILE:-.devcontainer/docker-compose.deply.yml}"
CLICKHOUSE_SERVICE="${CLICKHOUSE_SERVICE:-condev-monitor-clickhouse}"
SCHEMA_DIR="${SCHEMA_DIR:-.devcontainer/clickhouse/init}"
requested_database="${CLICKHOUSE_DATABASE:-${CLICKHOUSE_DB:-}}"

validate_database_name() {
  database_name="$1"
  case "$database_name" in
    [A-Za-z_]*) ;;
    *)
      echo "Invalid ClickHouse database name: use only ASCII letters, digits, and underscores, and do not start with a digit." >&2
      exit 1
      ;;
  esac
  case "$database_name" in
    *[!A-Za-z0-9_]*)
      echo "Invalid ClickHouse database name: use only ASCII letters, digits, and underscores, and do not start with a digit." >&2
      exit 1
      ;;
  esac
}

if [ -n "$requested_database" ]; then
  validate_database_name "$requested_database"
fi

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

if [ ! -d "$SCHEMA_DIR" ]; then
  echo "Schema directory not found: $SCHEMA_DIR" >&2
  exit 1
fi

container_id="$(docker_compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps -q "$CLICKHOUSE_SERVICE" 2>/dev/null | head -n 1 || true)"
if [ -z "$container_id" ]; then
  echo "ClickHouse container not found (project=$PROJECT_NAME service=$CLICKHOUSE_SERVICE compose=$COMPOSE_FILE)" >&2
  exit 1
fi

container_database="$(docker exec "$container_id" sh -c 'printf %s "${CLICKHOUSE_DATABASE:-${CLICKHOUSE_DB:-}}"' 2>/dev/null || true)"
clickhouse_database="${requested_database:-${container_database:-lemonade}}"
validate_database_name "$clickhouse_database"

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

schema_files="$(find "$SCHEMA_DIR" -maxdepth 1 -type f -name '*.sql' | sort)"
if [ -z "$schema_files" ]; then
  echo "No schema files found in: $SCHEMA_DIR" >&2
  exit 1
fi

echo "Initializing ClickHouse schema (idempotent)..."
docker exec "$container_id" clickhouse-client \
  --query "CREATE DATABASE IF NOT EXISTS \`$clickhouse_database\`"
for schema_file in $schema_files; do
  echo "Applying $(basename "$schema_file")..."
  docker exec -i "$container_id" clickhouse-client \
    --database "$clickhouse_database" \
    --multiquery < "$schema_file"
done

echo "Verifying tables in $clickhouse_database..."
docker exec "$container_id" clickhouse-client \
  --database "$clickhouse_database" \
  --query "SHOW TABLES"
