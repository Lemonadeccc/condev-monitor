-- Versioned, address-free Webhook registry references.
-- Endpoint URLs and signing secrets stay in the server-side secret registry.

ALTER TABLE public.animation_lab_alert_state
    ADD COLUMN IF NOT EXISTS "transitionEventId" uuid;

UPDATE public.animation_lab_alert_state AS state
SET "transitionEventId" = (
    SELECT event.id
    FROM public.animation_lab_alert_event AS event
    WHERE event."appId" = state."appId"
      AND event."stateId" = state.id
      AND event."toState" = state.status
    ORDER BY event."createdAt" DESC, event.id DESC
    LIMIT 1
)
WHERE state."transitionEventId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_alert_event_id_state_app_unique
    ON public.animation_lab_alert_event (id, "stateId", "appId");

ALTER TABLE public.animation_lab_alert_state
    DROP CONSTRAINT IF EXISTS animation_lab_alert_state_transition_event_app_fk,
    ADD CONSTRAINT animation_lab_alert_state_transition_event_app_fk
        FOREIGN KEY ("transitionEventId", id, "appId")
        REFERENCES public.animation_lab_alert_event(id, "stateId", "appId")
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.animation_lab_alert_state
    DROP CONSTRAINT IF EXISTS animation_lab_alert_state_ack_open_check,
    ADD CONSTRAINT animation_lab_alert_state_ack_open_check
        CHECK ("acknowledgedAt" IS NULL OR status = 'open') NOT VALID;

ALTER TABLE public.animation_lab_alert_state
    VALIDATE CONSTRAINT animation_lab_alert_state_ack_open_check;

ALTER TABLE public.animation_lab_notification_destination
    ADD COLUMN IF NOT EXISTS "registryRevision" character varying(64);

ALTER TABLE public.animation_lab_notification_destination
    DROP CONSTRAINT IF EXISTS animation_lab_notification_destination_kind_check,
    ADD CONSTRAINT animation_lab_notification_destination_kind_check
        CHECK (kind IN ('local', 'owner-email', 'webhook')),
    DROP CONSTRAINT IF EXISTS animation_lab_notification_destination_registry_revision_check,
    ADD CONSTRAINT animation_lab_notification_destination_registry_revision_check
        CHECK (
            (kind = 'webhook' AND "registryRevision" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
            OR (kind IN ('local', 'owner-email') AND "registryRevision" IS NULL)
        );

ALTER TABLE public.animation_lab_notification_outbox
    ADD COLUMN IF NOT EXISTS "registryRevision" character varying(64),
    DROP CONSTRAINT IF EXISTS animation_lab_notification_outbox_registry_revision_check,
    ADD CONSTRAINT animation_lab_notification_outbox_registry_revision_check
        CHECK (
            "registryRevision" IS NULL
            OR "registryRevision" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
        ),
    DROP CONSTRAINT IF EXISTS animation_lab_notification_outbox_attempt_order_check,
    ADD CONSTRAINT animation_lab_notification_outbox_attempt_order_check
        CHECK ("attemptCount" <= "maxAttempts") NOT VALID,
    DROP CONSTRAINT IF EXISTS animation_lab_notification_outbox_processing_lease_check,
    ADD CONSTRAINT animation_lab_notification_outbox_processing_lease_check
        CHECK (
            (state = 'processing' AND "leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL)
            OR (state <> 'processing' AND "leaseOwner" IS NULL AND "leaseUntil" IS NULL)
        ) NOT VALID,
    DROP CONSTRAINT IF EXISTS animation_lab_notification_outbox_delivered_at_check,
    ADD CONSTRAINT animation_lab_notification_outbox_delivered_at_check
        CHECK (
            (state = 'delivered' AND "deliveredAt" IS NOT NULL)
            OR (state <> 'delivered' AND "deliveredAt" IS NULL)
        ) NOT VALID;

ALTER TABLE public.animation_lab_notification_outbox
    VALIDATE CONSTRAINT animation_lab_notification_outbox_attempt_order_check,
    VALIDATE CONSTRAINT animation_lab_notification_outbox_processing_lease_check,
    VALIDATE CONSTRAINT animation_lab_notification_outbox_delivered_at_check;
