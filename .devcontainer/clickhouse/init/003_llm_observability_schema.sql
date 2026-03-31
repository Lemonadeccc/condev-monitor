-- LLM Observability schema (idempotent).
-- AI-specific tables, fully isolated from lemonade.events (frontend monitoring).
-- Partition by month, TTL 90 days default.

-- ① Root Trace — one row per LLM request / agent run
CREATE TABLE IF NOT EXISTS lemonade.ai_traces (
    trace_id      String,
    app_id        String,
    session_id    String         DEFAULT '',
    user_id       String         DEFAULT '',
    name          String         DEFAULT '',
    source        LowCardinality(String) DEFAULT '',  -- 'node-sdk'|'python-sdk'|'tailer'
    framework     LowCardinality(String) DEFAULT '',  -- 'manual'|'langchain'|'langgraph'|'vercel-ai'
    status        LowCardinality(String) DEFAULT 'ok',
    model         String         DEFAULT '',
    provider      String         DEFAULT '',
    environment   String         DEFAULT '',
    release       String         DEFAULT '',
    tags          Array(String)  DEFAULT [],
    input_tokens  UInt32         DEFAULT 0,
    output_tokens UInt32         DEFAULT 0,
    total_cost    Float64        DEFAULT 0,
    started_at    DateTime64(3, 'UTC'),
    ended_at      Nullable(DateTime64(3, 'UTC')),
    duration_ms   Float64        DEFAULT 0,
    error_message String         DEFAULT '',
    metadata      String         DEFAULT '{}'
) ENGINE = ReplacingMergeTree(started_at)
  PARTITION BY toYYYYMM(started_at)
  ORDER BY (app_id, trace_id)
  TTL toDateTime(started_at) + INTERVAL 90 DAY;

-- ② Spans — child observations within a trace (tree via parent_span_id)
CREATE TABLE IF NOT EXISTS lemonade.ai_spans (
    span_id        String,
    trace_id       String,
    parent_span_id String         DEFAULT '',
    app_id         String,
    name           String,
    span_kind      LowCardinality(String) DEFAULT 'span',
    -- span_kind values: entrypoint|llm|retrieval|rerank|embedding|chain|tool|graph_node|load|split|transform|cache|stage|event
    status         LowCardinality(String) DEFAULT 'ok',
    model          String         DEFAULT '',
    provider       String         DEFAULT '',
    input_tokens   UInt32         DEFAULT 0,
    output_tokens  UInt32         DEFAULT 0,
    started_at     DateTime64(3, 'UTC'),
    ended_at       Nullable(DateTime64(3, 'UTC')),
    duration_ms    Float64        DEFAULT 0,
    input          String         DEFAULT '',   -- JSON, controlled by capturePrompt
    output         String         DEFAULT '',   -- JSON
    error_message  String         DEFAULT '',
    attributes     String         DEFAULT '{}'  -- JSON
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(started_at)
  ORDER BY (app_id, trace_id, span_id)
  TTL toDateTime(started_at) + INTERVAL 90 DAY;

-- ③ Feedback / Scores — user ratings and LLM-as-Judge evaluations
CREATE TABLE IF NOT EXISTS lemonade.ai_feedback (
    id          UUID           DEFAULT generateUUIDv4(),
    trace_id    String,
    span_id     String         DEFAULT '',
    app_id      String,
    name        String,        -- 'relevance'|'thumbs'|'faithfulness' etc.
    value       Float64,       -- 0.0-1.0 or 1/-1 for thumbs
    comment     String         DEFAULT '',
    source      LowCardinality(String) DEFAULT 'sdk',  -- 'sdk'|'ui'|'llm-judge'
    created_at  DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (app_id, trace_id, created_at)
  TTL toDateTime(created_at) + INTERVAL 180 DAY;

-- ④ Ingestion Runs — document ingest pipeline tracking (MODULAR-RAG) -- cspell:disable-line
CREATE TABLE IF NOT EXISTS lemonade.ai_ingestion_runs (
    run_id      String,
    app_id      String,
    trace_id    String         DEFAULT '',
    file_name   String         DEFAULT '',
    file_size   UInt64         DEFAULT 0,
    status      LowCardinality(String) DEFAULT 'ok',
    chunk_count UInt32         DEFAULT 0,
    token_count UInt32         DEFAULT 0,
    duration_ms Float64        DEFAULT 0,
    error_msg   String         DEFAULT '',
    started_at  DateTime64(3, 'UTC'),
    ended_at    Nullable(DateTime64(3, 'UTC'))
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(started_at)
  ORDER BY (app_id, run_id)
  TTL toDateTime(started_at) + INTERVAL 90 DAY;

-- ⑤ Evaluations — RAGAS / custom LLM-as-Judge metric results
CREATE TABLE IF NOT EXISTS lemonade.ai_evaluations (
    eval_id    UUID           DEFAULT generateUUIDv4(),
    trace_id   String,
    app_id     String,
    evaluator  String,        -- 'ragas'|'custom'|'human'
    metric     String,        -- 'faithfulness'|'answer_relevancy'|'context_precision'
    score      Float64,       -- 0.0-1.0
    model      String         DEFAULT '',
    created_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (app_id, trace_id, metric)
  TTL toDateTime(created_at) + INTERVAL 180 DAY;
