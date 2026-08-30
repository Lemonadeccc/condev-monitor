#!/usr/bin/env sh
set -eu

group_id="${1:-}"
if [ -z "$group_id" ]; then
  echo "Usage: $0 <consumer-group> <topic> [topic ...]" >&2
  exit 2
fi
shift

if [ "$#" -eq 0 ]; then
  echo "At least one expected topic is required." >&2
  exit 2
fi

case "$group_id" in
  *[!A-Za-z0-9._-]*)
    echo "Consumer group contains unsupported characters: $group_id" >&2
    exit 2
    ;;
esac

kafka_container="${KAFKA_CONTAINER:-condev-monitor-kafka}"
timeout_seconds="${KAFKA_GROUP_TIMEOUT_SECONDS:-90}"
watch_pid="${KAFKA_GROUP_WATCH_PID:-}"

case "$timeout_seconds" in
  ''|*[!0-9]*)
    echo "KAFKA_GROUP_TIMEOUT_SECONDS must be a positive integer." >&2
    exit 2
    ;;
esac
if [ "$timeout_seconds" -le 0 ]; then
  echo "KAFKA_GROUP_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 2
fi

if [ -n "$watch_pid" ]; then
  case "$watch_pid" in
    *[!0-9]*)
      echo "KAFKA_GROUP_WATCH_PID must be a process id." >&2
      exit 2
      ;;
  esac
fi

kafka_groups='/opt/kafka/bin/kafka-consumer-groups.sh'
deadline=$(( $(date +%s) + timeout_seconds ))
last_state='Kafka consumer group has not been described yet.'
last_assignments='Kafka topic assignments have not been described yet.'

while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -n "$watch_pid" ] && ! kill -0 "$watch_pid" 2>/dev/null; then
    echo "The watched worker process exited before Kafka consumer readiness." >&2
    exit 1
  fi

  last_state="$(
    docker exec "$kafka_container" "$kafka_groups" \
      --bootstrap-server localhost:9092 \
      --describe \
      --group "$group_id" \
      --state 2>&1 || true
  )"

  if printf '%s\n' "$last_state" | awk -v group="$group_id" '
      $1 == group && $(NF - 1) == "Stable" && ($NF + 0) >= 1 { ready = 1 }
      END { exit ready ? 0 : 1 }
    '
  then
    last_assignments="$(
      docker exec "$kafka_container" "$kafka_groups" \
        --bootstrap-server localhost:9092 \
        --describe \
        --group "$group_id" 2>&1 || true
    )"

    all_topics_ready=true
    for topic in "$@"; do
      if ! printf '%s\n' "$last_assignments" | awk -v group="$group_id" -v topic="$topic" '
          $1 == group && $2 == topic { assigned = 1 }
          END { exit assigned ? 0 : 1 }
        '
      then
        all_topics_ready=false
        break
      fi
    done

    if [ "$all_topics_ready" = true ]; then
      echo "Kafka consumer group $group_id is Stable and owns every required topic."
      exit 0
    fi
  fi

  sleep 1
done

echo "Kafka consumer group $group_id did not become ready within ${timeout_seconds}s." >&2
printf '%s\n' "$last_state" >&2
printf '%s\n' "$last_assignments" >&2
exit 1
