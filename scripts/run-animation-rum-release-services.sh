#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

log_dir="${ANIMATION_RUM_RELEASE_LOG_DIR:-lab-results/animation-rum-release}"
dsn_port="${ANIMATION_RUM_RELEASE_DSN_PORT:-18082}"
monitor_port="${ANIMATION_RUM_RELEASE_MONITOR_PORT:-18081}"
group_seed="${ANIMATION_RUM_RELEASE_CONSUMER_GROUP:-condev-animation-release-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$}"
consumer_group="$(printf '%s' "$group_seed" | tr -c 'A-Za-z0-9._-' '-')"
kafka_container="${KAFKA_CONTAINER:-condev-monitor-kafka}"
project_name="${PROJECT_NAME:-condev-monitor}"
compose_file="${COMPOSE_FILE:-.devcontainer/docker-compose.yml}"

case "$dsn_port:$monitor_port" in
  *[!0-9:]*)
    echo "Animation RUM release ports must be integers." >&2
    exit 2
    ;;
esac
if [ "$dsn_port" -le 0 ] || [ "$dsn_port" -gt 65535 ] || [ "$monitor_port" -le 0 ] || [ "$monitor_port" -gt 65535 ]; then
  echo "Animation RUM release ports must be between 1 and 65535." >&2
  exit 2
fi
if [ "$dsn_port" -eq "$monitor_port" ]; then
  echo "DSN and Monitor release ports must be different." >&2
  exit 2
fi

mkdir -p "$log_dir"
service_pids=''
last_pid=''
worker_started=false

capture_infrastructure_logs() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -p "$project_name" -f "$compose_file" logs --no-color > "$log_dir/infrastructure.log" 2>&1 || true
  fi
}

delete_test_consumer_group() {
  if [ "$worker_started" != true ]; then
    return
  fi

  attempts=10
  while [ "$attempts" -gt 0 ]; do
    if docker exec "$kafka_container" /opt/kafka/bin/kafka-consumer-groups.sh \
      --bootstrap-server localhost:9092 \
      --delete \
      --group "$consumer_group" > "$log_dir/kafka-group-cleanup.log" 2>&1
    then
      return
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
}

cleanup() {
  status=$?
  trap - EXIT INT TERM

  for pid in $service_pids; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in $service_pids; do
    wait "$pid" 2>/dev/null || true
  done

  delete_test_consumer_group || true
  capture_infrastructure_logs
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_service() {
  name="$1"
  shift
  "$@" > "$log_dir/$name.log" 2>&1 &
  last_pid=$!
  service_pids="$service_pids $last_pid"
  echo "Started $name (pid $last_pid)."
}

wait_for_http() {
  name="$1"
  pid="$2"
  url="$3"
  log_file="$4"
  attempts=90

  while [ "$attempts" -gt 0 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited before becoming healthy." >&2
      tail -n 120 "$log_file" >&2 || true
      return 1
    fi
    if curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then
      echo "$name is healthy at $url."
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done

  echo "$name did not become healthy at $url." >&2
  tail -n 120 "$log_file" >&2 || true
  return 1
}

export NODE_ENV=production
export DB_TYPE=postgres
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"
export DB_USERNAME="${DB_USERNAME:-postgres}"
export DB_PASSWORD="${DB_PASSWORD:-condevPostgres}"
export DB_DATABASE="${DB_DATABASE:-postgres}"
export DB_AUTOLOAD=true
export DB_SYNC=false
export CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"
export CLICKHOUSE_USERNAME="${CLICKHOUSE_USERNAME:-lemonade}"
export CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-condevClickhouse}"
export CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-lemonade}"
export KAFKA_BROKERS="${KAFKA_BROKERS:-127.0.0.1:9094}"
export KAFKA_CLIENT_ID="condev-animation-release"
export KAFKA_CONSUMER_GROUP="$consumer_group"
export KAFKA_EVENTS_TOPIC="${KAFKA_EVENTS_TOPIC:-monitor.sdk.events.v1}"
export KAFKA_REPLAYS_TOPIC="${KAFKA_REPLAYS_TOPIC:-monitor.sdk.replays.v1}"
export KAFKA_AI_TOPIC="${KAFKA_AI_TOPIC:-condev.ai.events}"
export KAFKA_ANIMATION_RUM_V3_TOPIC="${KAFKA_ANIMATION_RUM_V3_TOPIC:-monitor.sdk.animation-rum.soft-navigation.v3}"
export KAFKA_DLQ_TOPIC="${KAFKA_DLQ_TOPIC:-monitor.sdk.dlq.v1}"
export KAFKA_ENABLED=true
export KAFKA_FALLBACK_TO_CLICKHOUSE=false
export INGEST_MODE=kafka
export ANIMATION_RUM_V2_OUTBOX_ENABLED=true
export ANIMATION_RUM_V3_OUTBOX_ENABLED=true
export ANIMATION_RUM_V2_OUTBOX_POLL_MS=100
export ANIMATION_RUM_V3_OUTBOX_POLL_MS=100
export ANIMATION_RUM_V2_RETENTION_ENABLED=false
export NORMAL_BATCH_MAX_WAIT_MS=100
export MAIL_ON=false
export AUTH_REQUIRE_EMAIL_VERIFICATION=false
export JWT_SECRET="${JWT_SECRET:-condev-animation-release-test-secret}"

if [ "${SKIP_ANIMATION_RUM_RELEASE_BUILD:-false}" != true ]; then
  pnpm turbo build --filter=dsn-server --filter=event-worker --filter=monitor
fi

start_service event-worker pnpm --filter event-worker start:prod
worker_pid="$last_pid"
worker_started=true
KAFKA_GROUP_WATCH_PID="$worker_pid" \
KAFKA_GROUP_TIMEOUT_SECONDS="${KAFKA_GROUP_TIMEOUT_SECONDS:-90}" \
KAFKA_CONTAINER="$kafka_container" \
  sh "$script_dir/wait-kafka-consumer-group.sh" \
    "$consumer_group" \
    "$KAFKA_EVENTS_TOPIC" \
    "$KAFKA_REPLAYS_TOPIC" \
    "$KAFKA_AI_TOPIC" \
    "$KAFKA_ANIMATION_RUM_V3_TOPIC"

start_service monitor env PORT="$monitor_port" pnpm --filter monitor start:prod
monitor_pid="$last_pid"
start_service dsn-server env PORT="$dsn_port" pnpm --filter dsn-server start:prod
dsn_pid="$last_pid"

monitor_base_url="http://127.0.0.1:$monitor_port"
dsn_base_url="http://127.0.0.1:$dsn_port"
wait_for_http monitor "$monitor_pid" "$monitor_base_url/api/healthz" "$log_dir/monitor.log"
wait_for_http dsn-server "$dsn_pid" "$dsn_base_url/dsn-api/healthz" "$log_dir/dsn-server.log"

export TEST_POSTGRES_URL="postgresql://$DB_USERNAME:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_DATABASE"
export TEST_CLICKHOUSE_URL="$CLICKHOUSE_URL"
export TEST_CLICKHOUSE_USERNAME="$CLICKHOUSE_USERNAME"
export TEST_CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD"
export TEST_CLICKHOUSE_DATABASE="$CLICKHOUSE_DATABASE"
export TEST_DSN_BASE_URL="$dsn_base_url"
export TEST_MONITOR_BASE_URL="$monitor_base_url"
export TEST_ANIMATION_RUM_V2_PIPELINE_WRITE_SENTINEL='condev-animation-rum-v2-pipeline-e2e'
export TEST_POSTGRES_WRITE_SENTINEL='condev-animation-rum-v3-pipeline-e2e'
export TEST_ANIMATION_RUM_V2_EXPECTED_TRANSPORT=kafka
export TEST_ANIMATION_RUM_V3_EXPECTED_TRANSPORT=kafka
export RUN_CLICKHOUSE_INTEGRATION=1

pnpm test:animation-rum-v2:release
pnpm test:animation-rum-v3:release

printf '%s\n' \
  'Animation RUM v2 and v3 service-backed release gates passed.' \
  "consumer_group=$consumer_group" \
  "dsn_base_url=$dsn_base_url" \
  "monitor_base_url=$monitor_base_url" > "$log_dir/summary.txt"
