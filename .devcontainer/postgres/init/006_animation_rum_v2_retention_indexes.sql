-- Bound the production retention worker without indexing canonical envelope
-- text. The dependency index also protects parent receipt deletion checks;
-- PostgreSQL does not create an index automatically on the referencing side of
-- a foreign key.

CREATE INDEX IF NOT EXISTS animation_rum_v2_outbox_quarantine_retention_idx
    ON public.animation_rum_v2_outbox USING btree (quarantined_at, application_id, id)
    WHERE state = 'quarantined';

CREATE INDEX IF NOT EXISTS animation_rum_v2_outbox_dependency_idx
    ON public.animation_rum_v2_outbox USING btree (application_id, depends_on_capture_id)
    WHERE depends_on_capture_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS animation_rum_v2_receipt_terminal_expiry_idx
    ON public.animation_rum_v2_capture_receipt USING btree (expires_at, application_id, capture_id)
    WHERE delivery_state IN ('published', 'persisted', 'quarantined');
