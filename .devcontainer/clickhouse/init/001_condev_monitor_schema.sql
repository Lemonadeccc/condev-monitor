-- Condev Monitor ClickHouse schema (idempotent).
-- Mounted into /docker-entrypoint-initdb.d so new environments auto-initialize.

CREATE DATABASE IF NOT EXISTS lemonade;

-- Legacy table — kept for backward compatibility during migration.
CREATE TABLE IF NOT EXISTS lemonade.base_monitor_storage (
    app_id String,
    event_type String,
    message String,
    info JSON,
    created_at DateTime('Asia/Shanghai') DEFAULT now('Asia/Shanghai')
) ENGINE = MergeTree
ORDER BY tuple ()
TTL created_at + INTERVAL 30 DAY DELETE WHERE event_type = 'replay';

-- New primary events table (Phase 1).
CREATE TABLE IF NOT EXISTS lemonade.events (
    event_id     String,
    app_id       String,
    fingerprint  String DEFAULT '',
    event_type   String,
    message      String,
    info         JSON,
    sdk_version  String DEFAULT '',
    environment  String DEFAULT '',
    release      String DEFAULT '',
    received_at  DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai'),

    INDEX idx_fingerprint fingerprint TYPE bloom_filter GRANULARITY 3,
    INDEX idx_event_type event_type TYPE set(10) GRANULARITY 1,
    INDEX idx_received_at received_at TYPE minmax GRANULARITY 1
) ENGINE = ReplacingMergeTree(received_at)
ORDER BY (app_id, event_type, event_id)
PARTITION BY toYYYYMM(received_at)
TTL received_at + INTERVAL 90 DAY DELETE,
    received_at + INTERVAL 30 DAY DELETE WHERE event_type = 'replay';

-- Compatibility MV: mirror writes from new events table → legacy base_monitor_storage
-- so legacy readers continue to work during migration.
CREATE MATERIALIZED VIEW IF NOT EXISTS lemonade.events_to_legacy_mv
TO lemonade.base_monitor_storage AS
SELECT
    app_id,
    event_type,
    message,
    info,
    toDateTime(received_at, 'Asia/Shanghai') AS created_at
FROM lemonade.events;

-- Application settings used by dsn-server (e.g. replay_enabled).
-- monitor backend also creates/syncs this table, but having it here avoids startup races.
CREATE TABLE IF NOT EXISTS lemonade.app_settings (
    app_id String,
    replay_enabled UInt8,
    updated_at DateTime
) ENGINE = ReplacingMergeTree (updated_at)
ORDER BY app_id;

-- Materialized view used by dsn-server APIs (/span, /bugs).
CREATE MATERIALIZED VIEW IF NOT EXISTS lemonade.base_monitor_view (
    app_id String,
    info JSON,
    event_type String,
    message String,
    processes_message String,
    created_at DateTime('Asia/Shanghai')
) ENGINE = MergeTree
ORDER BY tuple ()
TTL created_at + INTERVAL 30 DAY DELETE WHERE event_type = 'replay' AS
SELECT
    app_id,
    info,
    event_type,
    message,
    concat('CONDEV', event_type) AS processes_message,
    now('Asia/Shanghai') AS created_at
FROM lemonade.base_monitor_storage;
