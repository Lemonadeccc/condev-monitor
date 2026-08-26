-- Local-first animation lab control plane.
-- Raw artifacts live in bounded filesystem/object storage; PostgreSQL stores only metadata.

CREATE TABLE IF NOT EXISTS public.animation_lab_run (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "createdBy" integer NOT NULL,
    name character varying(120) NOT NULL,
    "scenarioKey" character varying(120) NOT NULL,
    "targetOrigin" character varying(2048) DEFAULT ''::character varying NOT NULL,
    release character varying(120) DEFAULT ''::character varying NOT NULL,
    "buildId" character varying(120) DEFAULT ''::character varying NOT NULL,
    mode character varying(16) DEFAULT 'local'::character varying NOT NULL,
    status character varying(32) DEFAULT 'created'::character varying NOT NULL,
    phase character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    progress smallint DEFAULT 0 NOT NULL,
    config text DEFAULT '{}'::text NOT NULL,
    summary text DEFAULT '{}'::text NOT NULL,
    "errorCode" character varying(80),
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "completedAt" timestamp with time zone,
    "cancelledAt" timestamp with time zone,
    CONSTRAINT animation_lab_run_mode_check CHECK (mode = 'local'),
    CONSTRAINT animation_lab_run_status_check CHECK (status IN ('created', 'running', 'completed', 'failed', 'cancelled', 'expired')),
    CONSTRAINT animation_lab_run_phase_check CHECK (phase IN ('queued', 'claimed', 'preparing', 'warmup', 'measuring', 'tracing', 'lighthouse', 'processing', 'uploading', 'done')),
    CONSTRAINT animation_lab_run_progress_check CHECK (progress >= 0 AND progress <= 100),
    CONSTRAINT animation_lab_run_config_size_check CHECK (octet_length(config) <= 16384),
    CONSTRAINT animation_lab_run_summary_size_check CHECK (octet_length(summary) <= 65536),
    CONSTRAINT animation_lab_run_config_json_check CHECK (jsonb_typeof(config::jsonb) = 'object'),
    CONSTRAINT animation_lab_run_summary_json_check CHECK (jsonb_typeof(summary::jsonb) = 'object'),
    CONSTRAINT animation_lab_run_created_by_fk FOREIGN KEY ("createdBy") REFERENCES public.admin(id)
);

CREATE INDEX IF NOT EXISTS animation_lab_run_app_created_idx
    ON public.animation_lab_run USING btree ("appId", "createdAt");
CREATE INDEX IF NOT EXISTS animation_lab_run_app_status_idx
    ON public.animation_lab_run USING btree ("appId", status);

CREATE TABLE IF NOT EXISTS public.animation_lab_runner_grant (
    id uuid PRIMARY KEY,
    "runId" uuid NOT NULL,
    "appId" character varying(80) NOT NULL,
    "tokenHash" character varying(64) NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "consumedAt" timestamp with time zone,
    "lastUsedAt" timestamp with time zone,
    "revokedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_runner_grant_run_fk FOREIGN KEY ("runId") REFERENCES public.animation_lab_run(id) ON DELETE CASCADE,
    CONSTRAINT animation_lab_runner_grant_token_hash_check CHECK ("tokenHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_runner_grant_run_unique
    ON public.animation_lab_runner_grant USING btree ("runId");
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_runner_grant_token_unique
    ON public.animation_lab_runner_grant USING btree ("tokenHash");

CREATE TABLE IF NOT EXISTS public.animation_lab_artifact (
    id uuid PRIMARY KEY,
    "runId" uuid NOT NULL,
    "appId" character varying(80) NOT NULL,
    kind character varying(40) NOT NULL,
    "mimeType" character varying(120) NOT NULL,
    encoding character varying(16) DEFAULT 'identity'::character varying NOT NULL,
    "byteSize" bigint NOT NULL,
    sha256 character varying(64) NOT NULL,
    "idempotencyKeyHash" character varying(64) NOT NULL,
    "storageKey" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    CONSTRAINT animation_lab_artifact_run_fk FOREIGN KEY ("runId") REFERENCES public.animation_lab_run(id) ON DELETE CASCADE,
    CONSTRAINT animation_lab_artifact_kind_check CHECK (kind IN ('animation-report', 'trace', 'trace-index', 'trace-chunk', 'cpu-profile', 'lighthouse-json', 'lighthouse-html', 'runner-log')),
    CONSTRAINT animation_lab_artifact_encoding_check CHECK (encoding IN ('identity', 'gzip')),
    CONSTRAINT animation_lab_artifact_size_check CHECK ("byteSize" > 0 AND "byteSize" <= 67108864),
    CONSTRAINT animation_lab_artifact_sha_check CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT animation_lab_artifact_idempotency_hash_check CHECK ("idempotencyKeyHash" ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS animation_lab_artifact_run_idx
    ON public.animation_lab_artifact USING btree ("runId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_artifact_run_idempotency_unique
    ON public.animation_lab_artifact USING btree ("runId", "idempotencyKeyHash");
