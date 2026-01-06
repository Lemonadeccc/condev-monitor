-- Condev Monitor ClickHouse schema (idempotent).
-- Mounted into /docker-entrypoint-initdb.d so new environments auto-initialize.

CREATE DATABASE IF NOT EXISTS lemonade;

CREATE TABLE IF NOT EXISTS lemonade.base_monitor_storage (
    app_id String,
    event_type String,
    message String,
    info JSON,
    created_at DateTime('Asia/Shanghai') DEFAULT now('Asia/Shanghai')
) ENGINE = MergeTree
ORDER BY tuple ();

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
ORDER BY tuple () AS
SELECT
    app_id,
    info,
    event_type,
    message,
    concat('CONDEV', event_type) AS processes_message,
    now('Asia/Shanghai') AS created_at
FROM lemonade.base_monitor_storage;