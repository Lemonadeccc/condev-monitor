-- Independent Animation RUM v3 soft-navigation admission and delivery lane.
-- This control plane never stores raw browser evidence; the outbox contains
-- only a validated canonical Kafka envelope until delivery is acknowledged.

CREATE TABLE IF NOT EXISTS public.animation_rum_v3_soft_navigation_policy (
    application_id integer PRIMARY KEY,
    enabled boolean DEFAULT false NOT NULL,
    max_routes smallint DEFAULT 64 NOT NULL,
    max_deployments smallint DEFAULT 64 NOT NULL,
    minimum_capture_samples smallint DEFAULT 30 NOT NULL,
    next_outbox_sequence bigint DEFAULT 1 NOT NULL,
    receipt_retention_days smallint DEFAULT 180 NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone DEFAULT now(),
    CONSTRAINT animation_rum_v3_soft_navigation_policy_application_fk
        FOREIGN KEY (application_id) REFERENCES public.application(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_policy_created_by_fk
        FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_policy_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_policy_limits_check CHECK
        (max_routes BETWEEN 1 AND 256 AND max_deployments BETWEEN 1 AND 512
         AND minimum_capture_samples BETWEEN 1 AND 1000
         AND receipt_retention_days BETWEEN 120 AND 365
         AND next_outbox_sequence >= 1),
    CONSTRAINT animation_rum_v3_soft_navigation_policy_disabled_check
        CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.animation_rum_v3_soft_navigation_route_registry (
    application_id integer NOT NULL,
    route_key character varying(96) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    updated_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    PRIMARY KEY (application_id, route_key),
    CONSTRAINT animation_rum_v3_soft_navigation_route_policy_fk
        FOREIGN KEY (application_id) REFERENCES public.animation_rum_v3_soft_navigation_policy(application_id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_route_created_by_fk
        FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_route_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_route_key_check CHECK (route_key ~ '^[a-z][a-z0-9._:-]{0,95}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_route_disabled_check
        CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.animation_rum_v3_soft_navigation_deployment_registry (
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
    CONSTRAINT animation_rum_v3_soft_navigation_deployment_policy_fk
        FOREIGN KEY (application_id) REFERENCES public.animation_rum_v3_soft_navigation_policy(application_id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_deployment_created_by_fk
        FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_deployment_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES public.admin(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_deployment_release_check
        CHECK (release = '' OR release ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_deployment_dist_check
        CHECK (dist = '' OR dist ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_deployment_environment_check
        CHECK (environment = '' OR environment ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_deployment_disabled_check
        CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.animation_rum_v3_soft_navigation_capture_receipt (
    application_id integer NOT NULL,
    capture_id character varying(80) NOT NULL,
    event_id character varying(80) NOT NULL,
    payload_sha256 character(64) NOT NULL,
    payload_hash_version smallint DEFAULT 1 NOT NULL,
    contract_version smallint NOT NULL,
    snapshot_schema_version smallint NOT NULL,
    capture_kind character varying(24) NOT NULL,
    scope character varying(8) NOT NULL,
    route_key character varying(96) NOT NULL,
    release character varying(64) NOT NULL,
    dist character varying(64) NOT NULL,
    environment character varying(64) NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    delivery_state character varying(16) DEFAULT 'pending' NOT NULL,
    delivery_via character varying(24),
    initial_received_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    persisted_at timestamp with time zone,
    quarantined_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (application_id, capture_id),
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_event_unique UNIQUE (application_id, event_id),
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_application_fk
        FOREIGN KEY (application_id) REFERENCES public.application(id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_route_fk
        FOREIGN KEY (application_id, route_key)
        REFERENCES public.animation_rum_v3_soft_navigation_route_registry(application_id, route_key) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_deployment_fk
        FOREIGN KEY (application_id, release, dist, environment)
        REFERENCES public.animation_rum_v3_soft_navigation_deployment_registry(application_id, release, dist, environment) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_ids_check CHECK
        (capture_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$' AND event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_hash_check CHECK
        (payload_sha256 ~ '^[a-f0-9]{64}$' AND payload_hash_version = 1),
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_contract_check CHECK
        (contract_version = 3 AND snapshot_schema_version = 1 AND capture_kind = 'soft-navigation'
         AND scope = 'page' AND route_key ~ '^[a-z][a-z0-9._:-]{0,95}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_state_check CHECK
        (delivery_state IN ('pending', 'published', 'persisted', 'quarantined')
         AND (delivery_via IS NULL OR delivery_via IN ('kafka', 'clickhouse-fallback'))),
    CONSTRAINT anim_rum_v3_receipt_state_consistency_check CHECK (
        (delivery_state = 'pending' AND delivery_via IS NULL AND published_at IS NULL AND persisted_at IS NULL AND quarantined_at IS NULL)
        OR (delivery_state = 'published' AND delivery_via = 'kafka' AND published_at IS NOT NULL AND persisted_at IS NULL AND quarantined_at IS NULL)
        OR (delivery_state = 'persisted' AND delivery_via = 'clickhouse-fallback' AND published_at IS NULL AND persisted_at IS NOT NULL AND quarantined_at IS NULL)
        OR (delivery_state = 'quarantined' AND delivery_via IS NULL AND published_at IS NULL AND persisted_at IS NULL AND quarantined_at IS NOT NULL)
    ),
    CONSTRAINT animation_rum_v3_soft_navigation_receipt_retention_check
        CHECK (expires_at >= initial_received_at + interval '120 days')
);

CREATE TABLE IF NOT EXISTS public.animation_rum_v3_soft_navigation_outbox (
    id bigserial PRIMARY KEY,
    application_id integer NOT NULL,
    capture_id character varying(80) NOT NULL,
    app_sequence bigint NOT NULL,
    topic character varying(255) NOT NULL,
    message_key character varying(80) NOT NULL,
    envelope_text text NOT NULL,
    state character varying(16) DEFAULT 'pending' NOT NULL,
    attempt_count smallint DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(64),
    lease_until timestamp with time zone,
    last_error_code character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    quarantined_at timestamp with time zone,
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_capture_unique UNIQUE (application_id, capture_id),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_sequence_unique UNIQUE (application_id, app_sequence),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_receipt_fk
        FOREIGN KEY (application_id, capture_id)
        REFERENCES public.animation_rum_v3_soft_navigation_capture_receipt(application_id, capture_id) ON DELETE RESTRICT,
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_sequence_check CHECK (app_sequence >= 1),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_topic_check CHECK (topic ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_key_check CHECK (octet_length(message_key) BETWEEN 1 AND 80),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_envelope_check CHECK
        (octet_length(envelope_text) BETWEEN 2 AND 98304 AND jsonb_typeof(envelope_text::jsonb) = 'object'),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_state_check CHECK (state IN ('pending', 'quarantined')),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_attempt_check CHECK (attempt_count >= 0),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_lease_check CHECK
        ((lease_owner IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_error_code_check CHECK
        (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT animation_rum_v3_soft_navigation_outbox_state_consistency_check CHECK
        ((state = 'pending' AND quarantined_at IS NULL)
         OR (state = 'quarantined' AND quarantined_at IS NOT NULL AND lease_owner IS NULL AND lease_until IS NULL AND last_error_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS animation_rum_v3_soft_navigation_route_enabled_idx
    ON public.animation_rum_v3_soft_navigation_route_registry (application_id, route_key) WHERE enabled;
CREATE INDEX IF NOT EXISTS animation_rum_v3_soft_navigation_deployment_enabled_idx
    ON public.animation_rum_v3_soft_navigation_deployment_registry (application_id, release, dist, environment) WHERE enabled;
CREATE INDEX IF NOT EXISTS animation_rum_v3_soft_navigation_receipt_app_updated_idx
    ON public.animation_rum_v3_soft_navigation_capture_receipt (application_id, updated_at DESC, capture_id)
    INCLUDE (event_id, delivery_state, published_at, persisted_at, quarantined_at);
CREATE INDEX IF NOT EXISTS animation_rum_v3_soft_navigation_receipt_terminal_expiry_idx
    ON public.animation_rum_v3_soft_navigation_capture_receipt (expires_at, application_id, capture_id)
    WHERE delivery_state IN ('published', 'persisted', 'quarantined');
CREATE INDEX IF NOT EXISTS animation_rum_v3_soft_navigation_outbox_pending_idx
    ON public.animation_rum_v3_soft_navigation_outbox (next_attempt_at, application_id, app_sequence) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS animation_rum_v3_soft_navigation_outbox_app_order_idx
    ON public.animation_rum_v3_soft_navigation_outbox (application_id, app_sequence) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS anim_rum_v3_outbox_quarantine_retention_idx
    ON public.animation_rum_v3_soft_navigation_outbox (quarantined_at, application_id, id) WHERE state = 'quarantined';
