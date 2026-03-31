#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

PROJECT_NAME="${PROJECT_NAME:-condev-monitor}"
COMPOSE_FILE="${COMPOSE_FILE:-.devcontainer/docker-compose.deply.yml}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-condev-monitor-postgres}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-condev-monitor-postgres}"
MIGRATION_DIR="${MIGRATION_DIR:-.devcontainer/postgres/init}"
DB_USERNAME="${DB_USERNAME:-postgres}"
DB_DATABASE="${DB_DATABASE:-postgres}"
BASELINE_MIGRATION="${BASELINE_MIGRATION:-001_monitor_schema.sql}"
EXPECTED_MONITOR_TABLE_COUNT=10

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

container_id="$(docker ps -q --filter "name=$POSTGRES_CONTAINER" 2>/dev/null | head -n 1 || true)"

if [ -z "$container_id" ]; then
  container_id="$(docker_compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps -q "$POSTGRES_SERVICE" 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$container_id" ]; then
  echo "Postgres container not found (tried name=$POSTGRES_CONTAINER)" >&2
  exit 1
fi

if [ ! -d "$MIGRATION_DIR" ]; then
  echo "Migration directory not found: $MIGRATION_DIR" >&2
  exit 1
fi

echo "Waiting for Postgres to be ready..."
tries=60
while [ "$tries" -gt 0 ]; do
  if docker exec "$container_id" pg_isready -U "$DB_USERNAME" -d "$DB_DATABASE" >/dev/null 2>&1; then
    break
  fi
  tries=$((tries - 1))
  sleep 2
done

if [ "$tries" -le 0 ]; then
  echo "Postgres did not become ready in time." >&2
  exit 1
fi

psql_exec() {
  docker exec -i "$container_id" psql -v ON_ERROR_STOP=1 -U "$DB_USERNAME" -d "$DB_DATABASE" "$@"
}

psql_exec <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  name varchar(255) PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

migration_files="$(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' | sort)"
if [ -z "$migration_files" ]; then
  echo "No migration files found in: $MIGRATION_DIR" >&2
  exit 1
fi

baseline_applied="$(psql_exec -Atc "SELECT 1 FROM public.schema_migrations WHERE name = '$BASELINE_MIGRATION' LIMIT 1")"
if [ -z "$baseline_applied" ]; then
  existing_monitor_tables="$(psql_exec -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('admin', 'application', 'sourcemap', 'sourcemap_token', 'ai_prompt', 'ai_prompt_version', 'ai_dataset', 'ai_dataset_item', 'ai_experiment', 'ai_experiment_run')")"
  application_enum_exists="$(psql_exec -Atc "SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'application_type_enum'")"
  if [ "${existing_monitor_tables:-0}" -eq "$EXPECTED_MONITOR_TABLE_COUNT" ] && [ "${application_enum_exists:-0}" -eq 1 ]; then
    echo "Existing monitor schema detected, marking baseline migration as applied..."
    psql_exec -c "INSERT INTO public.schema_migrations (name) VALUES ('$BASELINE_MIGRATION') ON CONFLICT (name) DO NOTHING;"
  elif [ "${existing_monitor_tables:-0}" -gt 0 ] || [ "${application_enum_exists:-0}" -gt 0 ]; then
    echo "Partial monitor schema detected in Postgres. Refusing to auto-mark baseline migration." >&2
    echo "Expected ${EXPECTED_MONITOR_TABLE_COUNT} monitor tables and application_type_enum, found tables=${existing_monitor_tables:-0}, enum=${application_enum_exists:-0}." >&2
    echo "Complete the schema manually or restore from backup before retrying deploy." >&2
    exit 1
  fi
fi

echo "Applying Postgres migrations..."
for migration_file in $migration_files; do
  migration_name="$(basename "$migration_file")"
  already_applied="$(psql_exec -Atc "SELECT 1 FROM public.schema_migrations WHERE name = '$migration_name' LIMIT 1")"
  if [ -n "$already_applied" ]; then
    echo "Skipping $migration_name (already applied)"
    continue
  fi

  echo "Applying $migration_name..."
  {
    printf 'BEGIN;\n'
    cat "$migration_file"
    printf "\nINSERT INTO public.schema_migrations (name) VALUES ('%s');\n" "$migration_name"
    printf 'COMMIT;\n'
  } | psql_exec
done

echo "Verifying monitor tables..."
psql_exec -c "\dt" || true
