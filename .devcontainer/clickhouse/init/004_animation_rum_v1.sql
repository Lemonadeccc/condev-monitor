-- Animation RUM v1 schema (idempotent).
-- Deliberately isolated from the legacy events table/materialized views.
-- The caller selects the validated CLICKHOUSE_DATABASE/CLICKHOUSE_DB database.

CREATE TABLE IF NOT EXISTS animation_rum_captures_v1 (
    event_id                String,
    capture_id              String,
    app_id                  String,
    contract_version        UInt8,
    snapshot_schema_version UInt8,
    captured_at             DateTime64(3, 'UTC'),
    received_at             DateTime64(3, 'UTC'),
    release                 String DEFAULT '',
    dist                    String DEFAULT '',
    environment             LowCardinality(String) DEFAULT '',
    sdk_version             String DEFAULT '',
    monitor_version         String,
    sample_rate             Float64,
    sampling_policy_version UInt16,
    route_key               String DEFAULT '',
    runtime_family          LowCardinality(String) DEFAULT 'unknown',
    context_json            String DEFAULT '{}',
    capabilities_json       String DEFAULT '{}',
    coverage_json           String DEFAULT '{}',
    metric_count            UInt16
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, capture_id)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS animation_rum_metrics_v1 (
    event_id                String,
    capture_id              String,
    app_id                  String,
    captured_at             DateTime64(3, 'UTC'),
    received_at             DateTime64(3, 'UTC'),
    release                 String DEFAULT '',
    dist                    String DEFAULT '',
    environment             LowCardinality(String) DEFAULT '',
    sample_rate             Float64,
    sampling_policy_version UInt16,
    route_key               String DEFAULT '',
    runtime_family          LowCardinality(String) DEFAULT 'unknown',
    family                  LowCardinality(String),
    name                    LowCardinality(String),
    stat                    LowCardinality(String),
    unit                    LowCardinality(String),
    value                   Nullable(Float64),
    samples                 Nullable(UInt64),
    status                  LowCardinality(String)
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, capture_id, family, name, stat)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;

-- Reserved for short-lived, server-generated diagnostic references only.
-- No arbitrary client text, stack, selector, URL, or source snippet is accepted.
CREATE TABLE IF NOT EXISTS animation_rum_diagnostics_v1 (
    diagnostic_id String,
    event_id      String,
    capture_id    String,
    app_id        String,
    release       String DEFAULT '',
    dist          String DEFAULT '',
    kind          LowCardinality(String),
    artifact_key  String DEFAULT '',
    generated_line Nullable(UInt32),
    generated_column Nullable(UInt32),
    duration_ms   Nullable(Float64),
    captured_at   DateTime64(3, 'UTC'),
    received_at   DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, capture_id, diagnostic_id)
  TTL toDateTime(captured_at) + INTERVAL 7 DAY;
