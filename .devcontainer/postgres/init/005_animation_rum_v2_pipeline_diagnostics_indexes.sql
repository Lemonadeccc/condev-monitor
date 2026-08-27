-- Keep the authenticated pipeline diagnostic polling path bounded by one
-- application and a recent transition window. These indexes contain only
-- control-plane identities and closed delivery metadata; no payload text is
-- included.

CREATE INDEX IF NOT EXISTS animation_rum_v2_receipt_app_updated_idx
    ON public.animation_rum_v2_capture_receipt USING btree (application_id, updated_at DESC, capture_id)
    INCLUDE (event_id, delivery_state, published_at, persisted_at, quarantined_at);

CREATE INDEX IF NOT EXISTS animation_rum_v2_outbox_app_state_updated_idx
    ON public.animation_rum_v2_outbox USING btree (application_id, state, updated_at DESC, app_sequence)
    INCLUDE (attempt_count, next_attempt_at, lease_until, created_at);
