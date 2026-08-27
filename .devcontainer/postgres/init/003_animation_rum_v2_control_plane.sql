-- Privacy-bounded Animation RUM v2 admission and delivery control plane.
-- Browser payloads are not stored here. Registries bound cardinality, receipts
-- reserve identities, and the outbox contains only the validated canonical
-- Kafka envelope until it is acknowledged.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.application
        GROUP BY "appId"
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot enable Animation RUM v2: duplicate application.appId values exist';
    END IF;
END
$$;

-- appId is the public ingestion identity throughout the existing platform. A
-- deleted application's identity must not be silently reused because historic
-- ClickHouse rows are keyed by appId.
CREATE UNIQUE INDEX IF NOT EXISTS application_app_id_unique
    ON public.application USING btree ("appId");

CREATE TABLE IF NOT EXISTS public.animation_rum_v2_policy (
    application_id integer PRIMARY KEY,
    enabled boolean DEFAULT false NOT NULL,
    max_routes smallint DEFAULT 64 NOT NULL,
    max_targets smallint DEFAULT 256 NOT NULL,
    max_deployments smallint DEFAULT 64 NOT NULL,
    next_outbox_sequence bigint DEFAULT 1 NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone DEFAULT now(),
    CONSTRAINT animation_rum_v2_policy_application_fk
        FOREIGN KEY (application_id) REFERENCES public.application(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_policy_created_by_fk
        FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_policy_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_policy_route_limit_check
        CHECK (max_routes >= 1 AND max_routes <= 256),
    CONSTRAINT animation_rum_v2_policy_target_limit_check
        CHECK (max_targets >= 1 AND max_targets <= 2048),
    CONSTRAINT animation_rum_v2_policy_deployment_limit_check
        CHECK (max_deployments >= 1 AND max_deployments <= 512),
    CONSTRAINT animation_rum_v2_policy_sequence_check
        CHECK (next_outbox_sequence >= 1),
    CONSTRAINT animation_rum_v2_policy_disabled_check
        CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.animation_rum_v2_route_registry (
    application_id integer NOT NULL,
    route_key character varying(96) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    PRIMARY KEY (application_id, route_key),
    CONSTRAINT animation_rum_v2_route_policy_fk
        FOREIGN KEY (application_id) REFERENCES public.animation_rum_v2_policy(application_id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_route_created_by_fk
        FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_route_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_route_key_check
        CHECK (route_key ~ '^[a-z][a-z0-9._:-]{0,95}$'),
    CONSTRAINT animation_rum_v2_route_disabled_check
        CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS animation_rum_v2_route_enabled_idx
    ON public.animation_rum_v2_route_registry USING btree (application_id, route_key)
    WHERE enabled;

CREATE TABLE IF NOT EXISTS public.animation_rum_v2_target_registry (
    application_id integer NOT NULL,
    route_key character varying(96) NOT NULL,
    target_key character varying(48) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    PRIMARY KEY (application_id, route_key, target_key),
    CONSTRAINT animation_rum_v2_target_route_fk
        FOREIGN KEY (application_id, route_key)
        REFERENCES public.animation_rum_v2_route_registry(application_id, route_key) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_target_created_by_fk
        FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_target_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_target_key_check
        CHECK (target_key ~ '^[a-z][a-z0-9._-]{0,47}$'),
    CONSTRAINT animation_rum_v2_target_disabled_check
        CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS animation_rum_v2_target_enabled_idx
    ON public.animation_rum_v2_target_registry USING btree (application_id, route_key, target_key)
    WHERE enabled;

CREATE TABLE IF NOT EXISTS public.animation_rum_v2_deployment_registry (
    application_id integer NOT NULL,
    release character varying(64) NOT NULL,
    dist character varying(64) NOT NULL,
    environment character varying(64) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    PRIMARY KEY (application_id, release, dist, environment),
    CONSTRAINT animation_rum_v2_deployment_policy_fk
        FOREIGN KEY (application_id) REFERENCES public.animation_rum_v2_policy(application_id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_deployment_created_by_fk
        FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_deployment_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_deployment_release_check
        CHECK (release = '' OR release ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
    CONSTRAINT animation_rum_v2_deployment_dist_check
        CHECK (dist = '' OR dist ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
    CONSTRAINT animation_rum_v2_deployment_environment_check
        CHECK (environment = '' OR environment ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
    CONSTRAINT animation_rum_v2_deployment_disabled_check
        CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS animation_rum_v2_deployment_enabled_idx
    ON public.animation_rum_v2_deployment_registry USING btree (application_id, release, dist, environment)
    WHERE enabled;

CREATE TABLE IF NOT EXISTS public.animation_rum_v2_capture_receipt (
    application_id integer NOT NULL,
    capture_id character varying(80) NOT NULL,
    event_id character varying(80) NOT NULL,
    payload_sha256 character(64) NOT NULL,
    contract_version smallint NOT NULL,
    snapshot_schema_version smallint NOT NULL,
    scope character varying(8) NOT NULL,
    parent_capture_id character varying(80),
    route_key character varying(96),
    target_key character varying(48),
    release character varying(64) NOT NULL,
    dist character varying(64) NOT NULL,
    environment character varying(64) NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    delivery_state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    delivery_via character varying(24),
    initial_received_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    persisted_at timestamp with time zone,
    quarantined_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (application_id, capture_id),
    CONSTRAINT animation_rum_v2_receipt_event_unique UNIQUE (application_id, event_id),
    CONSTRAINT animation_rum_v2_receipt_application_fk
        FOREIGN KEY (application_id) REFERENCES public.application(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_receipt_parent_fk
        FOREIGN KEY (application_id, parent_capture_id)
        REFERENCES public.animation_rum_v2_capture_receipt(application_id, capture_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
    CONSTRAINT animation_rum_v2_receipt_route_fk
        FOREIGN KEY (application_id, route_key)
        REFERENCES public.animation_rum_v2_route_registry(application_id, route_key) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_receipt_target_fk
        FOREIGN KEY (application_id, route_key, target_key)
        REFERENCES public.animation_rum_v2_target_registry(application_id, route_key, target_key) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_receipt_deployment_fk
        FOREIGN KEY (application_id, release, dist, environment)
        REFERENCES public.animation_rum_v2_deployment_registry(application_id, release, dist, environment) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_receipt_capture_id_check
        CHECK (capture_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$'),
    CONSTRAINT animation_rum_v2_receipt_event_id_check
        CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$'),
    CONSTRAINT animation_rum_v2_receipt_hash_check
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT animation_rum_v2_receipt_version_check
        CHECK (contract_version = 2 AND snapshot_schema_version = 1),
    CONSTRAINT animation_rum_v2_receipt_scope_check
        CHECK (scope IN ('page', 'target')),
    CONSTRAINT animation_rum_v2_receipt_route_key_check
        CHECK (route_key IS NULL OR route_key ~ '^[a-z][a-z0-9._:-]{0,95}$'),
    CONSTRAINT animation_rum_v2_receipt_target_key_check
        CHECK (target_key IS NULL OR target_key ~ '^[a-z][a-z0-9._-]{0,47}$'),
    CONSTRAINT animation_rum_v2_receipt_identity_check
        CHECK (
            (scope = 'page' AND parent_capture_id IS NULL AND target_key IS NULL)
            OR
            (scope = 'target' AND parent_capture_id IS NOT NULL AND parent_capture_id <> capture_id
                AND route_key IS NOT NULL AND target_key IS NOT NULL)
        ),
    CONSTRAINT animation_rum_v2_receipt_state_check
        CHECK (delivery_state IN ('pending', 'published', 'persisted', 'quarantined')),
    CONSTRAINT animation_rum_v2_receipt_via_check
        CHECK (delivery_via IS NULL OR delivery_via IN ('kafka', 'clickhouse', 'clickhouse-fallback')),
    CONSTRAINT animation_rum_v2_receipt_state_consistency_check
        CHECK (
            (delivery_state = 'pending' AND delivery_via IS NULL
                AND published_at IS NULL AND persisted_at IS NULL AND quarantined_at IS NULL)
            OR
            (delivery_state = 'published' AND delivery_via IS NOT NULL AND delivery_via = 'kafka'
                AND published_at IS NOT NULL AND persisted_at IS NULL AND quarantined_at IS NULL)
            OR
            (delivery_state = 'persisted' AND delivery_via IS NOT NULL
                AND delivery_via IN ('clickhouse', 'clickhouse-fallback')
                AND published_at IS NULL AND persisted_at IS NOT NULL AND quarantined_at IS NULL)
            OR
            (delivery_state = 'quarantined' AND delivery_via IS NULL
                AND published_at IS NULL AND persisted_at IS NULL AND quarantined_at IS NOT NULL)
        ),
    CONSTRAINT animation_rum_v2_receipt_retention_check
        CHECK (expires_at >= initial_received_at + interval '120 days')
);

CREATE INDEX IF NOT EXISTS animation_rum_v2_receipt_parent_idx
    ON public.animation_rum_v2_capture_receipt USING btree (application_id, parent_capture_id)
    WHERE parent_capture_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS animation_rum_v2_receipt_state_idx
    ON public.animation_rum_v2_capture_receipt USING btree (delivery_state, updated_at);
CREATE INDEX IF NOT EXISTS animation_rum_v2_receipt_expiry_idx
    ON public.animation_rum_v2_capture_receipt USING btree (expires_at);

CREATE TABLE IF NOT EXISTS public.animation_rum_v2_outbox (
    id bigserial PRIMARY KEY,
    application_id integer NOT NULL,
    capture_id character varying(80) NOT NULL,
    app_sequence bigint NOT NULL,
    depends_on_capture_id character varying(80),
    topic character varying(255) NOT NULL,
    message_key character varying(80) NOT NULL,
    envelope_text text NOT NULL,
    state character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count smallint DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(64),
    lease_until timestamp with time zone,
    last_error_code character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    quarantined_at timestamp with time zone,
    CONSTRAINT animation_rum_v2_outbox_capture_unique UNIQUE (application_id, capture_id),
    CONSTRAINT animation_rum_v2_outbox_sequence_unique UNIQUE (application_id, app_sequence),
    CONSTRAINT animation_rum_v2_outbox_receipt_fk
        FOREIGN KEY (application_id, capture_id)
        REFERENCES public.animation_rum_v2_capture_receipt(application_id, capture_id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_outbox_dependency_fk
        FOREIGN KEY (application_id, depends_on_capture_id)
        REFERENCES public.animation_rum_v2_capture_receipt(application_id, capture_id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v2_outbox_sequence_check
        CHECK (app_sequence >= 1),
    CONSTRAINT animation_rum_v2_outbox_dependency_check
        CHECK (depends_on_capture_id IS NULL OR depends_on_capture_id <> capture_id),
    CONSTRAINT animation_rum_v2_outbox_topic_check
        CHECK (topic ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'),
    CONSTRAINT animation_rum_v2_outbox_key_check
        CHECK (octet_length(message_key) >= 1 AND octet_length(message_key) <= 80),
    CONSTRAINT animation_rum_v2_outbox_envelope_size_check
        CHECK (octet_length(envelope_text) >= 2 AND octet_length(envelope_text) <= 98304),
    CONSTRAINT animation_rum_v2_outbox_envelope_json_check
        CHECK (jsonb_typeof(envelope_text::jsonb) = 'object'),
    CONSTRAINT animation_rum_v2_outbox_state_check
        CHECK (state IN ('pending', 'quarantined')),
    CONSTRAINT animation_rum_v2_outbox_attempt_check
        CHECK (attempt_count >= 0),
    CONSTRAINT animation_rum_v2_outbox_lease_check
        CHECK ((lease_owner IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
    CONSTRAINT animation_rum_v2_outbox_error_code_check
        CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT animation_rum_v2_outbox_state_consistency_check
        CHECK (
            (state = 'pending' AND quarantined_at IS NULL)
            OR
            (state = 'quarantined' AND quarantined_at IS NOT NULL
                AND lease_owner IS NULL AND lease_until IS NULL AND last_error_code IS NOT NULL)
        )
);

-- A dispatcher must claim only the oldest pending sequence for each app, hold a
-- per-application PostgreSQL advisory lock across Kafka send + acknowledgement,
-- and wait until a target's parent receipt is published or persisted.
CREATE INDEX IF NOT EXISTS animation_rum_v2_outbox_pending_idx
    ON public.animation_rum_v2_outbox USING btree (next_attempt_at, application_id, app_sequence)
    WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS animation_rum_v2_outbox_app_order_idx
    ON public.animation_rum_v2_outbox USING btree (application_id, app_sequence)
    WHERE state = 'pending';
