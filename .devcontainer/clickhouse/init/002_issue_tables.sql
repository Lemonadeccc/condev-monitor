-- Issue tracking tables for semantic grouping (Phase 4).

CREATE TABLE IF NOT EXISTS lemonade.issues (
    issue_id         String,
    app_id           String,
    fingerprint_hash String,
    title            String DEFAULT '',
    status           LowCardinality(String) DEFAULT 'open', -- open | resolved | ignored | merged
    issue_type       LowCardinality(String) DEFAULT 'error',
    message          String DEFAULT '',
    stack_signature  String DEFAULT '',
    occurrence_count UInt64 DEFAULT 1,
    first_seen_at    DateTime64(3, 'Asia/Shanghai'),
    last_seen_at     DateTime64(3, 'Asia/Shanghai'),
    merged_into      Nullable(String) DEFAULT NULL,
    updated_at       DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai')
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (app_id, issue_id);

CREATE TABLE IF NOT EXISTS lemonade.issue_embeddings (
    app_id           String,
    issue_id         String,
    fingerprint_hash String,
    embedding_source LowCardinality(String) DEFAULT 'all-MiniLM-L6-v2',
    vector           Array(Float32),
    created_at       DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai')
) ENGINE = MergeTree
ORDER BY (app_id, issue_id, created_at);

-- Distributed cron lock table.
-- ReplacingMergeTree with updated_at as version: latest write wins after FINAL.
-- TTL auto-cleans stale locks so no manual reaper is needed.
CREATE TABLE IF NOT EXISTS lemonade.cron_locks (
    lock_name    String,
    holder_id    String,
    acquired_at  DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai'),
    ttl_seconds  UInt32 DEFAULT 300,
    updated_at   DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3, 'Asia/Shanghai')
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY lock_name
TTL acquired_at + toIntervalSecond(ttl_seconds) DELETE;
