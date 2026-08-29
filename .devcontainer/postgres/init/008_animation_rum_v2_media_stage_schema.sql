-- Animation RUM v2 keeps its wire contract at version 2 while allowing the
-- caller-attested media-stage snapshot extension introduced as schema 2.
-- Install and validate the broader constraint before replacing the schema-1
-- constraint. Keep the state transition in one statement so direct psql use is
-- atomic under autocommit as well as under scripts/init-postgres.sh's outer
-- transaction. A prior interrupted/manual attempt may have left either name.

DO $migration$
BEGIN
    LOCK TABLE public.animation_rum_v2_capture_receipt IN ACCESS EXCLUSIVE MODE;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.animation_rum_v2_capture_receipt'::regclass
          AND conname = 'animation_rum_v2_receipt_supported_version_check'
    ) THEN
        ALTER TABLE public.animation_rum_v2_capture_receipt
            DROP CONSTRAINT animation_rum_v2_receipt_supported_version_check;
    END IF;

    ALTER TABLE public.animation_rum_v2_capture_receipt
        ADD CONSTRAINT animation_rum_v2_receipt_supported_version_check
        CHECK (contract_version = 2 AND snapshot_schema_version IN (1, 2))
        NOT VALID;

    ALTER TABLE public.animation_rum_v2_capture_receipt
        VALIDATE CONSTRAINT animation_rum_v2_receipt_supported_version_check;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.animation_rum_v2_capture_receipt'::regclass
          AND conname = 'animation_rum_v2_receipt_version_check'
    ) THEN
        ALTER TABLE public.animation_rum_v2_capture_receipt
            DROP CONSTRAINT animation_rum_v2_receipt_version_check;
    END IF;

    ALTER TABLE public.animation_rum_v2_capture_receipt
        RENAME CONSTRAINT animation_rum_v2_receipt_supported_version_check
        TO animation_rum_v2_receipt_version_check;
END
$migration$;
