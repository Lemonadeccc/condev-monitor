-- Versioned project policy, pinned baseline, deterministic evaluation, and alert event state.
-- Runner evidence remains in immutable Lab artifacts; these tables store platform-owned policy decisions only.

CREATE TABLE IF NOT EXISTS public.animation_lab_project_policy (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "createdBy" integer NOT NULL,
    "policyKey" character varying(120) NOT NULL,
    version integer NOT NULL,
    name character varying(120) NOT NULL,
    "metricCatalogVersion" smallint NOT NULL,
    digest character varying(64) NOT NULL,
    definition text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_project_policy_created_by_fk FOREIGN KEY ("createdBy") REFERENCES public.admin(id),
    CONSTRAINT animation_lab_project_policy_version_check CHECK (version >= 1 AND version <= 1000000),
    CONSTRAINT animation_lab_project_policy_catalog_check CHECK ("metricCatalogVersion" BETWEEN 1 AND 5),
    CONSTRAINT animation_lab_project_policy_digest_check CHECK (digest ~ '^[a-f0-9]{64}$'),
    CONSTRAINT animation_lab_project_policy_definition_size_check CHECK (octet_length(definition) <= 65536),
    CONSTRAINT animation_lab_project_policy_definition_json_check CHECK (jsonb_typeof(definition::jsonb) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_project_policy_app_key_version_unique
    ON public.animation_lab_project_policy ("appId", "policyKey", version);
CREATE INDEX IF NOT EXISTS animation_lab_project_policy_app_created_idx
    ON public.animation_lab_project_policy ("appId", "createdAt");

CREATE TABLE IF NOT EXISTS public.animation_lab_baseline_binding (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "createdBy" integer NOT NULL,
    "bindingKey" character varying(120) NOT NULL,
    version integer NOT NULL,
    "scenarioKey" character varying(120) NOT NULL,
    "routeKey" character varying(160) NOT NULL,
    "baselineRunId" uuid NOT NULL,
    "policyId" uuid NOT NULL,
    "comparisonContextDigest" character varying(64) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_baseline_binding_created_by_fk FOREIGN KEY ("createdBy") REFERENCES public.admin(id),
    CONSTRAINT animation_lab_baseline_binding_run_fk FOREIGN KEY ("baselineRunId") REFERENCES public.animation_lab_run(id),
    CONSTRAINT animation_lab_baseline_binding_policy_fk FOREIGN KEY ("policyId") REFERENCES public.animation_lab_project_policy(id),
    CONSTRAINT animation_lab_baseline_binding_version_check CHECK (version >= 1 AND version <= 1000000),
    CONSTRAINT animation_lab_baseline_binding_digest_check CHECK ("comparisonContextDigest" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_baseline_binding_app_key_version_unique
    ON public.animation_lab_baseline_binding ("appId", "bindingKey", version);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_baseline_binding_app_key_active_unique
    ON public.animation_lab_baseline_binding ("appId", "bindingKey") WHERE active;
CREATE INDEX IF NOT EXISTS animation_lab_baseline_binding_app_active_idx
    ON public.animation_lab_baseline_binding ("appId", active);

CREATE TABLE IF NOT EXISTS public.animation_lab_policy_evaluation (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "createdBy" integer NOT NULL,
    "bindingId" uuid NOT NULL,
    "policyId" uuid NOT NULL,
    "beforeRunId" uuid NOT NULL,
    "afterRunId" uuid NOT NULL,
    "policyDigest" character varying(64) NOT NULL,
    verdict character varying(24) NOT NULL,
    result text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_policy_evaluation_created_by_fk FOREIGN KEY ("createdBy") REFERENCES public.admin(id),
    CONSTRAINT animation_lab_policy_evaluation_binding_fk FOREIGN KEY ("bindingId") REFERENCES public.animation_lab_baseline_binding(id),
    CONSTRAINT animation_lab_policy_evaluation_policy_fk FOREIGN KEY ("policyId") REFERENCES public.animation_lab_project_policy(id),
    CONSTRAINT animation_lab_policy_evaluation_before_run_fk FOREIGN KEY ("beforeRunId") REFERENCES public.animation_lab_run(id),
    CONSTRAINT animation_lab_policy_evaluation_after_run_fk FOREIGN KEY ("afterRunId") REFERENCES public.animation_lab_run(id),
    CONSTRAINT animation_lab_policy_evaluation_digest_check CHECK ("policyDigest" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT animation_lab_policy_evaluation_verdict_check CHECK (verdict IN ('within-policy', 'breach', 'indeterminate')),
    CONSTRAINT animation_lab_policy_evaluation_result_size_check CHECK (octet_length(result) <= 131072),
    CONSTRAINT animation_lab_policy_evaluation_result_json_check CHECK (jsonb_typeof(result::jsonb) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_policy_evaluation_identity_unique
    ON public.animation_lab_policy_evaluation ("bindingId", "afterRunId", "policyDigest");
CREATE INDEX IF NOT EXISTS animation_lab_policy_evaluation_app_created_idx
    ON public.animation_lab_policy_evaluation ("appId", "createdAt");

CREATE TABLE IF NOT EXISTS public.animation_lab_alert_state (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "bindingKey" character varying(120) NOT NULL,
    "bindingId" uuid NOT NULL,
    "ruleId" character varying(120) NOT NULL,
    status character varying(16) NOT NULL,
    severity character varying(16) NOT NULL,
    "lastEvaluationId" uuid NOT NULL,
    "openedAt" timestamp with time zone,
    "resolvedAt" timestamp with time zone,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_alert_state_binding_fk FOREIGN KEY ("bindingId") REFERENCES public.animation_lab_baseline_binding(id),
    CONSTRAINT animation_lab_alert_state_evaluation_fk FOREIGN KEY ("lastEvaluationId") REFERENCES public.animation_lab_policy_evaluation(id),
    CONSTRAINT animation_lab_alert_state_status_check CHECK (status IN ('healthy', 'open', 'unknown', 'superseded')),
    CONSTRAINT animation_lab_alert_state_severity_check CHECK (severity IN ('warning', 'critical'))
);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_alert_state_binding_rule_unique
    ON public.animation_lab_alert_state ("bindingId", "ruleId");
CREATE INDEX IF NOT EXISTS animation_lab_alert_state_app_status_idx
    ON public.animation_lab_alert_state ("appId", status);

CREATE TABLE IF NOT EXISTS public.animation_lab_alert_event (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "stateId" uuid NOT NULL,
    "evaluationId" uuid NOT NULL,
    "ruleId" character varying(120) NOT NULL,
    "eventType" character varying(16) NOT NULL,
    severity character varying(16) NOT NULL,
    "fromState" character varying(16) NOT NULL,
    "toState" character varying(16) NOT NULL,
    fingerprint character varying(64) NOT NULL,
    evidence text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_alert_event_state_fk FOREIGN KEY ("stateId") REFERENCES public.animation_lab_alert_state(id),
    CONSTRAINT animation_lab_alert_event_evaluation_fk FOREIGN KEY ("evaluationId") REFERENCES public.animation_lab_policy_evaluation(id),
    CONSTRAINT animation_lab_alert_event_type_check CHECK ("eventType" IN ('opened', 'resolved', 'superseded')),
    CONSTRAINT animation_lab_alert_event_severity_check CHECK (severity IN ('warning', 'critical')),
    CONSTRAINT animation_lab_alert_event_from_state_check CHECK ("fromState" IN ('healthy', 'open', 'unknown')),
    CONSTRAINT animation_lab_alert_event_to_state_check CHECK ("toState" IN ('healthy', 'open', 'unknown', 'superseded')),
    CONSTRAINT animation_lab_alert_event_fingerprint_check CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    CONSTRAINT animation_lab_alert_event_evidence_size_check CHECK (octet_length(evidence) <= 8192),
    CONSTRAINT animation_lab_alert_event_evidence_json_check CHECK (jsonb_typeof(evidence::jsonb) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_alert_event_fingerprint_unique
    ON public.animation_lab_alert_event (fingerprint);
CREATE INDEX IF NOT EXISTS animation_lab_alert_event_app_created_idx
    ON public.animation_lab_alert_event ("appId", "createdAt");

CREATE TABLE IF NOT EXISTS public.animation_lab_policy_evaluation_job (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "createdBy" integer NOT NULL,
    "runId" uuid NOT NULL,
    "bindingId" uuid NOT NULL,
    "bindingKey" character varying(120) NOT NULL,
    "policyDigest" character varying(64) NOT NULL,
    state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    "attemptCount" integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp with time zone NOT NULL,
    "leaseOwner" uuid,
    "leaseUntil" timestamp with time zone,
    "lastErrorCode" character varying(80),
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_policy_evaluation_job_created_by_fk FOREIGN KEY ("createdBy") REFERENCES public.admin(id),
    CONSTRAINT animation_lab_policy_evaluation_job_run_fk FOREIGN KEY ("runId") REFERENCES public.animation_lab_run(id),
    CONSTRAINT animation_lab_policy_evaluation_job_binding_fk FOREIGN KEY ("bindingId") REFERENCES public.animation_lab_baseline_binding(id),
    CONSTRAINT animation_lab_policy_evaluation_job_digest_check CHECK ("policyDigest" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT animation_lab_policy_evaluation_job_state_check CHECK (state IN ('pending', 'completed', 'quarantined')),
    CONSTRAINT animation_lab_policy_evaluation_job_attempt_check CHECK ("attemptCount" BETWEEN 0 AND 5)
);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_policy_evaluation_job_identity_unique
    ON public.animation_lab_policy_evaluation_job ("bindingId", "runId", "policyDigest");
CREATE INDEX IF NOT EXISTS animation_lab_policy_evaluation_job_due_idx
    ON public.animation_lab_policy_evaluation_job (state, "nextAttemptAt")
    WHERE state = 'pending';
