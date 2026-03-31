#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

PROJECT_NAME="${PROJECT_NAME:-condev-monitor}"
COMPOSE_FILE="${COMPOSE_FILE:-.devcontainer/docker-compose.deply.yml}"

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

echo "Starting infrastructure services first..."
docker_compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --build \
  condev-monitor-clickhouse \
  condev-monitor-postgres \
  condev-monitor-kafka

echo "Initializing Postgres schema..."
PROJECT_NAME="$PROJECT_NAME" COMPOSE_FILE="$COMPOSE_FILE" sh ./scripts/init-postgres.sh

echo "Initializing ClickHouse schema..."
PROJECT_NAME="$PROJECT_NAME" COMPOSE_FILE="$COMPOSE_FILE" sh ./scripts/init-clickhouse.sh

echo "Initializing Kafka topics..."
PROJECT_NAME="$PROJECT_NAME" COMPOSE_FILE="$COMPOSE_FILE" sh ./scripts/init-kafka-topics.sh

echo "Starting application services..."
docker_compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --build \
  condev-monitor-server \
  condev-dsn-server \
  condev-monitor-event-worker \
  condev-monitor-web \
  condev-monitor-caddy
