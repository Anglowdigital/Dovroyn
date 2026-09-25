-- Agent safety foundation: provenance, explicit action levels, approvals, and audit history.

ALTER TABLE public.pod_analysis
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS source_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS personal_data_detected BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS personal_data_categories TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.agent_action_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action_level TEXT NOT NULL CHECK (action_level IN ('research', 'draft', 'approve', 'execute')),
  action_type TEXT NOT NULL CHECK (length(trim(action_type)) BETWEEN 1 AND 100),
  target_connection_id UUID REFERENCES public.social_connections(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  approved_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  approval_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (action_level <> 'execute' OR (target_connection_id IS NOT NULL AND idempotency_key IS NOT NULL AND length(trim(idempotency_key)) >= 12)),
  CHECK ((status NOT IN ('approved', 'executing', 'completed')) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_action_requests_idempotency_idx
  ON public.agent_action_requests (pod_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_action_requests_pod_created_idx
  ON public.agent_action_requests (pod_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  action_request_id UUID REFERENCES public.agent_action_requests(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_audit_events_pod_created_idx
  ON public.agent_audit_events (pod_id, created_at DESC);

ALTER TABLE public.agent_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view agent action requests" ON public.agent_action_requests
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = pod_id AND p.user_id = (SELECT auth.uid())));

-- Browser clients may record research, drafts, and approval intents. Execute requests
-- are created by trusted server code after resolving the stored connection target.
CREATE POLICY "Owners can create non-execute agent requests" ON public.agent_action_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = (SELECT auth.uid())
    AND action_level <> 'execute'
    AND status = 'pending'
    AND EXISTS (SELECT 1 FROM public.pods p WHERE p.id = pod_id AND p.user_id = (SELECT auth.uid()))
  );

CREATE POLICY "Owners can view agent audit history" ON public.agent_audit_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = pod_id AND p.user_id = (SELECT auth.uid())));

REVOKE INSERT, UPDATE, DELETE ON public.agent_audit_events FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.agent_action_requests FROM anon, authenticated;

CREATE OR REPLACE FUNCTION private.audit_agent_action_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.agent_audit_events (pod_id, action_request_id, actor_id, event_type, details)
  VALUES (
    NEW.pod_id,
    NEW.id,
    COALESCE(NEW.approved_by, NEW.requested_by),
    CASE WHEN TG_OP = 'INSERT' THEN 'action_requested' ELSE 'action_status_changed' END,
    jsonb_build_object('action_level', NEW.action_level, 'action_type', NEW.action_type, 'status', NEW.status)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_agent_action_request ON public.agent_action_requests;
CREATE TRIGGER audit_agent_action_request
AFTER INSERT OR UPDATE OF status ON public.agent_action_requests
FOR EACH ROW EXECUTE FUNCTION private.audit_agent_action_request();

CREATE OR REPLACE FUNCTION public.review_agent_action(
  p_request_id UUID,
  p_approved BOOLEAN,
  p_note TEXT DEFAULT NULL
)
RETURNS public.agent_action_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_row public.agent_action_requests%ROWTYPE;
BEGIN
  SELECT ar.* INTO request_row
  FROM public.agent_action_requests ar
  JOIN public.pods p ON p.id = ar.pod_id
  WHERE ar.id = p_request_id
    AND p.user_id = (SELECT auth.uid())
    AND ar.status = 'pending'
  FOR UPDATE OF ar;

  IF NOT FOUND THEN RAISE EXCEPTION 'Pending action request not found.'; END IF;

  UPDATE public.agent_action_requests
  SET status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
      approved_by = (SELECT auth.uid()),
      approved_at = now(),
      approval_note = left(p_note, 1000),
      updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO request_row;
  RETURN request_row;
END;
$$;

REVOKE ALL ON FUNCTION public.review_agent_action(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_agent_action(UUID, BOOLEAN, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.finalize_pod_analysis(p_pod_id UUID, p_analysis JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  pod_row public.pods%ROWTYPE;
  locked_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO pod_row FROM public.pods p
  WHERE p.id = p_pod_id AND p.user_id = (SELECT auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pod not found or not owned by the signed-in user.'; END IF;
  IF pod_row.source_locked_at IS NOT NULL THEN RAISE EXCEPTION 'This pod has already been analysed and its source is locked.'; END IF;
  IF pod_row.source_type IS NULL OR pod_row.source_type NOT IN ('website', 'social', 'shopify', 'photos') THEN
    RAISE EXCEPTION 'Choose one supported primary source type before running analysis.';
  END IF;
  IF pod_row.source_type IN ('website', 'social', 'shopify') AND NULLIF(BTRIM(COALESCE(pod_row.source_url, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Add one primary URL before running analysis.';
  END IF;
  IF pod_row.source_type = 'photos' AND NOT EXISTS (SELECT 1 FROM public.pod_assets pa WHERE pa.pod_id = p_pod_id AND pa.asset_role = 'brand_photo') THEN
    RAISE EXCEPTION 'Add at least one brand photo before running analysis.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pod_assets pa WHERE pa.pod_id = p_pod_id AND pa.asset_role = 'logo') THEN
    RAISE EXCEPTION 'Add the brand logo before running analysis.';
  END IF;

  INSERT INTO public.pod_analysis (
    pod_id, brand_summary, tone, audience, offer_direction, campaign_angles,
    social_recommendations, content_ideas, evidence, confidence,
    source_captured_at, personal_data_detected, personal_data_categories, updated_at
  ) VALUES (
    p_pod_id, p_analysis->>'summary', p_analysis->>'tone', p_analysis->>'audience',
    p_analysis->>'offer', p_analysis->>'opportunity', COALESCE(p_analysis->'platforms', '[]'::JSONB)::TEXT,
    COALESCE(p_analysis->'pillars', '[]'::JSONB)::TEXT, COALESCE(p_analysis->'evidence', '[]'::JSONB),
    (p_analysis->>'confidence')::NUMERIC, (p_analysis->>'source_captured_at')::TIMESTAMPTZ,
    COALESCE((p_analysis->>'personal_data_detected')::BOOLEAN, false),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_analysis->'personal_data_categories', '[]'::JSONB))), NOW()
  )
  ON CONFLICT (pod_id) DO UPDATE SET
    brand_summary = EXCLUDED.brand_summary, tone = EXCLUDED.tone, audience = EXCLUDED.audience,
    offer_direction = EXCLUDED.offer_direction, campaign_angles = EXCLUDED.campaign_angles,
    social_recommendations = EXCLUDED.social_recommendations, content_ideas = EXCLUDED.content_ideas,
    evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence,
    source_captured_at = EXCLUDED.source_captured_at, personal_data_detected = EXCLUDED.personal_data_detected,
    personal_data_categories = EXCLUDED.personal_data_categories, updated_at = NOW();

  UPDATE public.pods SET source_locked_at = COALESCE(source_locked_at, NOW()), status = 'awaiting_direction', updated_at = NOW()
  WHERE id = p_pod_id RETURNING source_locked_at INTO locked_at;
  RETURN locked_at;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_pod_analysis(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_pod_analysis(UUID, JSONB) TO authenticated;

