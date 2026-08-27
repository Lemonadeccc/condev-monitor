-- Animation RUM v2 schema (idempotent and intentionally isolated from v1).
-- Only the closed, validated aggregate contract may be projected here. Never
-- persist selectors, DOM text, input values, URLs, raw events, coordinates,
-- keyframes, shader source, props, state, or arbitrary adapter metadata.

CREATE TABLE IF NOT EXISTS animation_rum_captures_v2 (
    event_id                  String,
    capture_id                String,
    parent_capture_id         String DEFAULT '',
    app_id                    String,
    scope                     LowCardinality(String),
    contract_version          UInt8,
    snapshot_schema_version   UInt8,
    captured_at               DateTime64(3, 'UTC'),
    received_at               DateTime64(3, 'UTC'),
    release                   String DEFAULT '',
    dist                      String DEFAULT '',
    environment               LowCardinality(String) DEFAULT '',
    sdk_version               String DEFAULT '',
    monitor_version           String,
    sample_rate               Float64,
    sampling_policy_version   UInt16,
    route_key                 LowCardinality(String) DEFAULT '',
    target_key                LowCardinality(String) DEFAULT '',
    visibility_state          LowCardinality(String) DEFAULT 'unknown',
    reduced_motion            Nullable(UInt8),
    viewport_bucket           LowCardinality(String) DEFAULT 'unknown',
    dpr_bucket                LowCardinality(String) DEFAULT 'unknown',
    refresh_hz                Nullable(Float64),
    refresh_budget_source     LowCardinality(String) DEFAULT 'unknown',
    refresh_budget_confidence LowCardinality(String) DEFAULT 'unknown',
    window_duration_ms        Float64,
    window_duration_capped    UInt8,
    runtime_framework         LowCardinality(String) DEFAULT 'unknown',
    runtime_renderer          LowCardinality(String) DEFAULT 'unknown',
    runtime_backend           LowCardinality(String) DEFAULT 'unknown',
    capabilities_json         String DEFAULT '{}',
    coverage_json             String DEFAULT '{}',
    capture_sufficiency       LowCardinality(String),
    capture_integrity         LowCardinality(String),
    capture_quality_reasons   Array(String) DEFAULT [],
    adapter_error_count       UInt32,
    provider_evidence_count   UInt16,
    metric_count              UInt16,
    CONSTRAINT rum_v2_capture_versions CHECK contract_version = 2 AND snapshot_schema_version = 1,
    CONSTRAINT rum_v2_capture_scope CHECK scope IN ('page', 'target'),
    CONSTRAINT rum_v2_capture_identity CHECK
        (scope = 'page' AND parent_capture_id = '' AND target_key = '') OR
        (scope = 'target' AND parent_capture_id != '' AND target_key != ''),
    CONSTRAINT rum_v2_capture_sampling CHECK sample_rate >= 0 AND sample_rate <= 1 AND sampling_policy_version >= 1,
    CONSTRAINT rum_v2_capture_window CHECK window_duration_ms >= 0 AND window_duration_ms <= 604800000,
    CONSTRAINT rum_v2_capture_counts CHECK
        adapter_error_count <= 1000000000 AND provider_evidence_count <= 96 AND metric_count >= 1 AND metric_count <= 128
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, capture_id)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS animation_rum_metrics_v2 (
    event_id                  String,
    capture_id                String,
    app_id                    String,
    scope                     LowCardinality(String),
    captured_at               DateTime64(3, 'UTC'),
    received_at               DateTime64(3, 'UTC'),
    release                   String DEFAULT '',
    dist                      String DEFAULT '',
    environment               LowCardinality(String) DEFAULT '',
    sample_rate               Float64,
    sampling_policy_version   UInt16,
    route_key                 LowCardinality(String) DEFAULT '',
    target_key                LowCardinality(String) DEFAULT '',
    runtime_framework         LowCardinality(String) DEFAULT 'unknown',
    runtime_renderer          LowCardinality(String) DEFAULT 'unknown',
    runtime_backend           LowCardinality(String) DEFAULT 'unknown',
    metric_id                 LowCardinality(String),
    family                    LowCardinality(String),
    name                      LowCardinality(String),
    stat                      LowCardinality(String),
    unit                      LowCardinality(String),
    relation                  LowCardinality(String),
    owner                     LowCardinality(String),
    value                     Nullable(Float64),
    samples                   Nullable(UInt64),
    status                    LowCardinality(String),
    CONSTRAINT rum_v2_metric_scope CHECK scope IN ('page', 'target'),
    CONSTRAINT rum_v2_metric_relation CHECK relation IN ('page-window', 'target-direct', 'target-temporal-overlap', 'adapter'),
    CONSTRAINT rum_v2_metric_status CHECK
        (status IN ('measured', 'partial') AND value IS NOT NULL AND samples IS NOT NULL) OR
        (status IN ('not-observed', 'not-instrumented', 'unsupported', 'unknown') AND value IS NULL AND samples IS NULL),
    CONSTRAINT rum_v2_metric_value CHECK value IS NULL OR value >= 0
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, capture_id, metric_id, relation)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS animation_rum_provider_evidence_v2 (
    event_id                  String,
    capture_id                String,
    app_id                    String,
    scope                     LowCardinality(String),
    captured_at               DateTime64(3, 'UTC'),
    received_at               DateTime64(3, 'UTC'),
    release                   String DEFAULT '',
    environment               LowCardinality(String) DEFAULT '',
    route_key                 LowCardinality(String) DEFAULT '',
    target_key                LowCardinality(String) DEFAULT '',
    owner                     LowCardinality(String),
    family                    LowCardinality(String),
    provider_version          LowCardinality(String),
    accepted                  UInt64,
    retained                  UInt64,
    evidence                  UInt64,
    dropped                   UInt64,
    rejected                  UInt64,
    truncated                 UInt8,
    CONSTRAINT rum_v2_provider_scope CHECK scope IN ('page', 'target'),
    CONSTRAINT rum_v2_provider_counts CHECK
        retained <= accepted AND evidence <= retained AND dropped = accepted - retained,
    CONSTRAINT rum_v2_provider_truncation CHECK truncated IN (0, 1) AND truncated = (dropped > 0)
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, capture_id, owner, family)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;
