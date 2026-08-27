-- Freeze the canonical payload hash independently from the RUM contract so a
-- future serializer revision cannot reinterpret an existing idempotency key.

ALTER TABLE public.animation_rum_v2_capture_receipt
    ADD COLUMN payload_hash_version smallint DEFAULT 1 NOT NULL;

ALTER TABLE public.animation_rum_v2_capture_receipt
    ADD CONSTRAINT animation_rum_v2_receipt_hash_version_check
    CHECK (payload_hash_version = 1);
