-- Keep every policy-layer relation inside one application even if a future
-- caller bypasses the service ownership checks. Existing single-column
-- foreign keys remain useful; these composite keys add the app boundary.

CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_run_id_app_unique
    ON public.animation_lab_run (id, "appId");
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_project_policy_id_app_unique
    ON public.animation_lab_project_policy (id, "appId");
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_baseline_binding_id_app_unique
    ON public.animation_lab_baseline_binding (id, "appId");
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_policy_evaluation_id_app_unique
    ON public.animation_lab_policy_evaluation (id, "appId");
CREATE UNIQUE INDEX IF NOT EXISTS animation_lab_alert_state_id_app_unique
    ON public.animation_lab_alert_state (id, "appId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_binding_policy_app_fk') THEN
        ALTER TABLE public.animation_lab_baseline_binding
            ADD CONSTRAINT anim_lab_binding_policy_app_fk
            FOREIGN KEY ("policyId", "appId")
            REFERENCES public.animation_lab_project_policy (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_binding_run_app_fk') THEN
        ALTER TABLE public.animation_lab_baseline_binding
            ADD CONSTRAINT anim_lab_binding_run_app_fk
            FOREIGN KEY ("baselineRunId", "appId")
            REFERENCES public.animation_lab_run (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_eval_binding_app_fk') THEN
        ALTER TABLE public.animation_lab_policy_evaluation
            ADD CONSTRAINT anim_lab_eval_binding_app_fk
            FOREIGN KEY ("bindingId", "appId")
            REFERENCES public.animation_lab_baseline_binding (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_eval_policy_app_fk') THEN
        ALTER TABLE public.animation_lab_policy_evaluation
            ADD CONSTRAINT anim_lab_eval_policy_app_fk
            FOREIGN KEY ("policyId", "appId")
            REFERENCES public.animation_lab_project_policy (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_eval_before_run_app_fk') THEN
        ALTER TABLE public.animation_lab_policy_evaluation
            ADD CONSTRAINT anim_lab_eval_before_run_app_fk
            FOREIGN KEY ("beforeRunId", "appId")
            REFERENCES public.animation_lab_run (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_eval_after_run_app_fk') THEN
        ALTER TABLE public.animation_lab_policy_evaluation
            ADD CONSTRAINT anim_lab_eval_after_run_app_fk
            FOREIGN KEY ("afterRunId", "appId")
            REFERENCES public.animation_lab_run (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_alert_state_binding_app_fk') THEN
        ALTER TABLE public.animation_lab_alert_state
            ADD CONSTRAINT anim_lab_alert_state_binding_app_fk
            FOREIGN KEY ("bindingId", "appId")
            REFERENCES public.animation_lab_baseline_binding (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_alert_state_eval_app_fk') THEN
        ALTER TABLE public.animation_lab_alert_state
            ADD CONSTRAINT anim_lab_alert_state_eval_app_fk
            FOREIGN KEY ("lastEvaluationId", "appId")
            REFERENCES public.animation_lab_policy_evaluation (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_alert_event_state_app_fk') THEN
        ALTER TABLE public.animation_lab_alert_event
            ADD CONSTRAINT anim_lab_alert_event_state_app_fk
            FOREIGN KEY ("stateId", "appId")
            REFERENCES public.animation_lab_alert_state (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_alert_event_eval_app_fk') THEN
        ALTER TABLE public.animation_lab_alert_event
            ADD CONSTRAINT anim_lab_alert_event_eval_app_fk
            FOREIGN KEY ("evaluationId", "appId")
            REFERENCES public.animation_lab_policy_evaluation (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_policy_job_run_app_fk') THEN
        ALTER TABLE public.animation_lab_policy_evaluation_job
            ADD CONSTRAINT anim_lab_policy_job_run_app_fk
            FOREIGN KEY ("runId", "appId")
            REFERENCES public.animation_lab_run (id, "appId") NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anim_lab_policy_job_binding_app_fk') THEN
        ALTER TABLE public.animation_lab_policy_evaluation_job
            ADD CONSTRAINT anim_lab_policy_job_binding_app_fk
            FOREIGN KEY ("bindingId", "appId")
            REFERENCES public.animation_lab_baseline_binding (id, "appId") NOT VALID;
    END IF;
END
$$;

ALTER TABLE public.animation_lab_baseline_binding VALIDATE CONSTRAINT anim_lab_binding_policy_app_fk;
ALTER TABLE public.animation_lab_baseline_binding VALIDATE CONSTRAINT anim_lab_binding_run_app_fk;
ALTER TABLE public.animation_lab_policy_evaluation VALIDATE CONSTRAINT anim_lab_eval_binding_app_fk;
ALTER TABLE public.animation_lab_policy_evaluation VALIDATE CONSTRAINT anim_lab_eval_policy_app_fk;
ALTER TABLE public.animation_lab_policy_evaluation VALIDATE CONSTRAINT anim_lab_eval_before_run_app_fk;
ALTER TABLE public.animation_lab_policy_evaluation VALIDATE CONSTRAINT anim_lab_eval_after_run_app_fk;
ALTER TABLE public.animation_lab_alert_state VALIDATE CONSTRAINT anim_lab_alert_state_binding_app_fk;
ALTER TABLE public.animation_lab_alert_state VALIDATE CONSTRAINT anim_lab_alert_state_eval_app_fk;
ALTER TABLE public.animation_lab_alert_event VALIDATE CONSTRAINT anim_lab_alert_event_state_app_fk;
ALTER TABLE public.animation_lab_alert_event VALIDATE CONSTRAINT anim_lab_alert_event_eval_app_fk;
ALTER TABLE public.animation_lab_policy_evaluation_job VALIDATE CONSTRAINT anim_lab_policy_job_run_app_fk;
ALTER TABLE public.animation_lab_policy_evaluation_job VALIDATE CONSTRAINT anim_lab_policy_job_binding_app_fk;
