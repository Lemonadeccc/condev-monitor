#!/usr/bin/env sh
set -eu

database="${CLICKHOUSE_DATABASE:-${CLICKHOUSE_DB:-lemonade}}"
schema_dir="${CLICKHOUSE_SCHEMA_DIR:-/opt/condev-monitor/clickhouse-schema}"

case "$database" in
  [A-Za-z_]*) ;;
  *)
    echo "Invalid ClickHouse database name: use only ASCII letters, digits, and underscores, and do not start with a digit." >&2
    exit 1
    ;;
esac
case "$database" in
  *[!A-Za-z0-9_]*)
    echo "Invalid ClickHouse database name: use only ASCII letters, digits, and underscores, and do not start with a digit." >&2
    exit 1
    ;;
esac

clickhouse-client \
  --host 127.0.0.1 \
  --user "${CLICKHOUSE_USER:-default}" \
  --password "${CLICKHOUSE_PASSWORD:-}" \
  --query "CREATE DATABASE IF NOT EXISTS \`$database\`"

for schema_file in "$schema_dir"/*.sql; do
  [ -f "$schema_file" ] || continue
  echo "Applying $(basename "$schema_file") to $database..."
  clickhouse-client \
    --host 127.0.0.1 \
    --user "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-}" \
    --database "$database" \
    --multiquery < "$schema_file"
done
