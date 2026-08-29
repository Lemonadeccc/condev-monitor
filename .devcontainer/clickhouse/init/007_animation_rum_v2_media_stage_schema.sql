-- Keep the Animation RUM wire contract at version 2 while admitting both the
-- original snapshot and the caller-attested media-stage schema extension.

ALTER TABLE animation_rum_captures_v2
    ADD CONSTRAINT IF NOT EXISTS rum_v2_capture_versions_schema_2
    CHECK contract_version = 2 AND snapshot_schema_version IN (1, 2);

ALTER TABLE animation_rum_captures_v2
    DROP CONSTRAINT IF EXISTS rum_v2_capture_versions;
