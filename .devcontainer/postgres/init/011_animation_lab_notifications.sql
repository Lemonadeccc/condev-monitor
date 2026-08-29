-- Closed notification destinations, transactional outbox delivery, and alert acknowledgement history.
-- Destinations intentionally store no address, URL, credential, or free-form notification body.

ALTER TABLE public.animation_lab_alert_state
    ADD COLUMN IF NOT EXISTS "acknowledgedBy" integer,
    ADD COLUMN IF NOT EXISTS "acknowledgedAt" timestamp with time zone;

ALTER TABLE public.animation_lab_alert_state
    DROP CONSTRAINT IF EXISTS animation_lab_alert_state_ack_pair_check,
    ADD CONSTRAINT animation_lab_alert_state_ack_pair_check
        CHECK (("acknowledgedBy" IS NULL) = ("acknowledgedAt" IS NULL));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'animation_lab_alert_state_ack_by_fk') THEN
        ALTER TABLE public.animation_lab_alert_state
            ADD CONSTRAINT animation_lab_alert_state_ack_by_fk FOREIGN KEY ("acknowledgedBy") REFERENCES public.admin(id);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.animation_lab_notification_destination (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "createdBy" integer NOT NULL,
    "destinationKey" character varying(120) NOT NULL,
    kind character varying(24) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "cooldownSeconds" integer DEFAULT 900 NOT NULL,
    "maxAttempts" smallint DEFAULT 3 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_notification_destination_app_fk FOREIGN KEY ("appId") REFERENCES public.application("appId"),
    CONSTRAINT animation_lab_notification_destination_created_by_fk FOREIGN KEY ("createdBy") REFERENCES public.admin(id),
    CONSTRAINT animation_lab_notification_destination_kind_check CHECK (kind IN ('local', 'owner-email')),
    CONSTRAINT animation_lab_notification_destination_cooldown_check CHECK ("cooldownSeconds" BETWEEN 0 AND 86400),
    CONSTRAINT animation_lab_notification_destination_attempts_check CHECK ("maxAttempts" BETWEEN 1 AND 10)
);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_notification_destination_app_key_unique
    ON public.animation_lab_notification_destination ("appId", "destinationKey");
CREATE INDEX IF NOT EXISTS animation_lab_notification_destination_app_enabled_idx
    ON public.animation_lab_notification_destination ("appId", enabled);
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_notification_destination_id_app_unique
    ON public.animation_lab_notification_destination (id, "appId");

-- Existing development volumes may predate 010_animation_lab_policy_app_integrity.sql.
-- Primary-key uniqueness makes these additive composite indexes safe and keeps this migration self-contained.
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_alert_event_id_app_unique
    ON public.animation_lab_alert_event (id, "appId");
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_alert_state_id_app_unique
    ON public.animation_lab_alert_state (id, "appId");

CREATE TABLE IF NOT EXISTS public.animation_lab_notification_outbox (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "eventId" uuid NOT NULL,
    "destinationId" uuid NOT NULL,
    "cooldownKey" character varying(64) NOT NULL,
    state character varying(16) NOT NULL,
    "attemptCount" smallint DEFAULT 0 NOT NULL,
    "maxAttempts" smallint NOT NULL,
    "nextAttemptAt" timestamp with time zone NOT NULL,
    "leaseOwner" uuid,
    "leaseUntil" timestamp with time zone,
    "lastResultCode" character varying(48),
    "deliveredAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_notification_outbox_event_app_fk FOREIGN KEY ("eventId", "appId") REFERENCES public.animation_lab_alert_event(id, "appId"),
    CONSTRAINT animation_lab_notification_outbox_destination_app_fk FOREIGN KEY ("destinationId", "appId") REFERENCES public.animation_lab_notification_destination(id, "appId"),
    CONSTRAINT animation_lab_notification_outbox_state_check CHECK (state IN ('pending', 'processing', 'retry', 'delivered', 'suppressed', 'cancelled', 'quarantined')),
    CONSTRAINT animation_lab_notification_outbox_attempts_check CHECK ("attemptCount" BETWEEN 0 AND 10 AND "maxAttempts" BETWEEN 1 AND 10),
    CONSTRAINT animation_lab_notification_outbox_cooldown_key_check CHECK ("cooldownKey" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE public.animation_lab_notification_outbox
    DROP CONSTRAINT IF EXISTS animation_lab_notification_outbox_state_check,
    ADD CONSTRAINT animation_lab_notification_outbox_state_check
        CHECK (state IN ('pending', 'processing', 'retry', 'delivered', 'suppressed', 'cancelled', 'quarantined'));
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_notification_outbox_event_destination_unique
    ON public.animation_lab_notification_outbox ("eventId", "destinationId");
CREATE INDEX IF NOT EXISTS animation_lab_notification_outbox_app_state_next_idx
    ON public.animation_lab_notification_outbox ("appId", state, "nextAttemptAt");
CREATE INDEX IF NOT EXISTS animation_lab_notification_outbox_cooldown_idx
    ON public.animation_lab_notification_outbox ("destinationId", "cooldownKey", "createdAt");

CREATE TABLE IF NOT EXISTS public.animation_lab_alert_acknowledgement (
    id uuid PRIMARY KEY,
    "appId" character varying(80) NOT NULL,
    "stateId" uuid NOT NULL,
    "actorId" integer NOT NULL,
    action character varying(16) NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animation_lab_alert_ack_state_app_fk FOREIGN KEY ("stateId", "appId") REFERENCES public.animation_lab_alert_state(id, "appId"),
    CONSTRAINT animation_lab_alert_ack_actor_fk FOREIGN KEY ("actorId") REFERENCES public.admin(id),
    CONSTRAINT animation_lab_alert_ack_action_check CHECK (action IN ('acknowledged', 'cleared'))
);
CREATE INDEX IF NOT EXISTS animation_lab_alert_ack_app_created_idx
    ON public.animation_lab_alert_acknowledgement ("appId", "createdAt");
CREATE INDEX IF NOT EXISTS animation_lab_alert_ack_state_created_idx
    ON public.animation_lab_alert_acknowledgement ("stateId", "createdAt");
