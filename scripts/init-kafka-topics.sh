#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

KAFKA_CONTAINER="${KAFKA_CONTAINER:-condev-monitor-kafka}"

# apache/kafka official image binary path
KAFKA_BIN="/opt/kafka/bin"

# Auto-detect container: try container name directly (works for both dev and deploy)
container_id="$(docker ps -q --filter "name=$KAFKA_CONTAINER" 2>/dev/null | head -n 1 || true)"

if [ -z "$container_id" ]; then
  # Fallback: try via compose
  PROJECT_NAME="${PROJECT_NAME:-condev-monitor}"
  COMPOSE_FILE="${COMPOSE_FILE:-.devcontainer/docker-compose.yml}"
  KAFKA_SERVICE="${KAFKA_SERVICE:-condev-monitor-kafka}"

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

  container_id="$(docker_compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps -q "$KAFKA_SERVICE" 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$container_id" ]; then
  echo "Kafka container not found (tried name=$KAFKA_CONTAINER)" >&2
  exit 1
fi

echo "Waiting for Kafka to be ready..."
tries=30
while [ "$tries" -gt 0 ]; do
  if docker exec "$container_id" "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 --list >/dev/null 2>&1; then
    break
  fi
  tries=$((tries - 1))
  sleep 2
done

if [ "$tries" -le 0 ]; then
  echo "Kafka did not become ready in time." >&2
  exit 1
fi

echo "Creating Kafka topics (idempotent)..."

docker exec "$container_id" "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 \
  --create --if-not-exists --topic monitor.sdk.events.v1 \
  --partitions 6 --replication-factor 1 \
  --config retention.ms=259200000

docker exec "$container_id" "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 \
  --create --if-not-exists --topic monitor.sdk.replays.v1 \
  --partitions 3 --replication-factor 1 \
  --config retention.ms=86400000

docker exec "$container_id" "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 \
  --create --if-not-exists --topic monitor.sdk.dlq.v1 \
  --partitions 1 --replication-factor 1 \
  --config retention.ms=604800000

echo "Verifying topics..."
docker exec "$container_id" "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server localhost:9092 --list || true
