-- Animation RUM v3 is an isolated soft-navigation lane. Only the closed,
-- validated three-vital aggregate is persisted; raw URLs, selectors, DOM
-- content, interaction coordinates, props and framework state are forbidden.

CREATE TABLE IF NOT EXISTS animation_rum_soft_navigation_captures_v3 (
    event_id String,
    capture_id String,
    app_id String,
    capture_kind LowCardinality(String),
    scope LowCardinality(String),
    contract_version UInt8,
    snapshot_schema_version UInt8,
    captured_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    release String DEFAULT '',
    dist String DEFAULT '',
    environment LowCardinality(String) DEFAULT '',
    sdk_version String,
    monitor_version String,
    sample_rate Float64,
    sampling_policy_version UInt16,
    route_key LowCardinality(String),
    runtime_framework LowCardinality(String) DEFAULT 'unknown',
    runtime_renderer LowCardinality(String) DEFAULT 'unknown',
    runtime_backend LowCardinality(String) DEFAULT 'unknown',
    visibility_state LowCardinality(String) DEFAULT 'unknown',
    reduced_motion Nullable(UInt8),
    viewport_bucket LowCardinality(String) DEFAULT 'unknown',
    dpr_bucket LowCardinality(String) DEFAULT 'unknown',
    refresh_hz Nullable(Float64),
    refresh_budget_source LowCardinality(String) DEFAULT 'unknown',
    refresh_budget_confidence LowCardinality(String) DEFAULT 'unknown',
    window_duration_ms Float64,
    window_duration_capped UInt8,
    capabilities_json String,
    coverage_json String,
    capture_sufficiency LowCardinality(String),
    capture_integrity LowCardinality(String),
    capture_quality_reasons Array(String),
    provider_evidence_count UInt8,
    metric_count UInt8,
    CONSTRAINT rum_v3_soft_navigation_version CHECK contract_version = 3 AND snapshot_schema_version = 1,
    CONSTRAINT rum_v3_soft_navigation_identity CHECK capture_kind = 'soft-navigation' AND scope = 'page',
    CONSTRAINT rum_v3_soft_navigation_sampling CHECK sample_rate >= 0 AND sample_rate <= 1 AND sampling_policy_version >= 1,
    CONSTRAINT rum_v3_soft_navigation_window CHECK window_duration_ms >= 0 AND window_duration_ms <= 604800000,
    CONSTRAINT rum_v3_soft_navigation_counts CHECK provider_evidence_count = 1 AND metric_count = 3
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, route_key, capture_id)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS animation_rum_soft_navigation_metrics_v3 (
    event_id String,
    capture_id String,
    app_id String,
    capture_kind LowCardinality(String),
    scope LowCardinality(String),
    captured_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    release String DEFAULT '',
    dist String DEFAULT '',
    environment LowCardinality(String) DEFAULT '',
    sample_rate Float64,
    sampling_policy_version UInt16,
    route_key LowCardinality(String),
    runtime_framework LowCardinality(String),
    runtime_renderer LowCardinality(String),
    runtime_backend LowCardinality(String),
    window_duration_ms Float64,
    window_duration_capped UInt8,
    metric_id LowCardinality(String),
    vital_name LowCardinality(String),
    unit LowCardinality(String),
    evidence_window LowCardinality(String),
    relation LowCardinality(String),
    owner LowCardinality(String),
    value Nullable(Float64),
    samples Nullable(UInt8),
    status LowCardinality(String),
    CONSTRAINT rum_v3_soft_navigation_metric_identity CHECK capture_kind = 'soft-navigation' AND scope = 'page',
    CONSTRAINT rum_v3_soft_navigation_metric_catalog CHECK
        metric_id IN ('vital.soft-navigation.cls.latest', 'vital.soft-navigation.inp.latest', 'vital.soft-navigation.lcp.latest')
        AND vital_name IN ('CLS', 'INP', 'LCP'),
    CONSTRAINT rum_v3_soft_navigation_metric_evidence CHECK
        evidence_window = 'soft-navigation-lifetime' AND relation = 'page-window' AND owner = 'web-vitals-runtime',
    CONSTRAINT rum_v3_soft_navigation_metric_status CHECK
        (status IN ('measured', 'partial') AND value IS NOT NULL AND samples = 1)
        OR (status IN ('not-observed', 'not-instrumented', 'unsupported', 'unknown') AND value IS NULL AND samples IS NULL)
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, route_key, capture_id, metric_id)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS animation_rum_soft_navigation_provider_evidence_v3 (
    event_id String,
    capture_id String,
    app_id String,
    capture_kind LowCardinality(String),
    scope LowCardinality(String),
    captured_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC'),
    release String DEFAULT '',
    dist String DEFAULT '',
    environment LowCardinality(String) DEFAULT '',
    route_key LowCardinality(String),
    runtime_framework LowCardinality(String),
    runtime_renderer LowCardinality(String),
    runtime_backend LowCardinality(String),
    window_duration_ms Float64,
    window_duration_capped UInt8,
    owner LowCardinality(String),
    family LowCardinality(String),
    provider_version LowCardinality(String),
    accepted UInt64,
    retained UInt64,
    evidence UInt64,
    dropped UInt64,
    rejected UInt64,
    truncated UInt8,
    CONSTRAINT rum_v3_soft_navigation_provider_identity CHECK
        capture_kind = 'soft-navigation' AND scope = 'page' AND owner = 'web-vitals-runtime' AND family = 'userOutcome',
    CONSTRAINT rum_v3_soft_navigation_provider_counts CHECK
        retained <= accepted AND evidence <= retained AND dropped = accepted - retained,
    CONSTRAINT rum_v3_soft_navigation_provider_truncation CHECK truncated IN (0, 1) AND truncated = (dropped > 0)
) ENGINE = ReplacingMergeTree(received_at)
  PARTITION BY toYYYYMM(captured_at)
  ORDER BY (app_id, route_key, capture_id, owner, family)
  TTL toDateTime(captured_at) + INTERVAL 90 DAY;
