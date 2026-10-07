-- Forward reconciliation after the live/remote agent-safety and free-tier changes.
-- Keeps provenance while adding colours, geography and hardened free-pod/source rules.
-- Existing source-lock triggers and table ownership policies are preserved.

CREATE OR REPLACE FUNCTION private.enforce_pod_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  caller_id UUID := (SELECT auth.uid());
  plan_limit INTEGER := 1;
  active_count INTEGER;
BEGIN
  IF caller_id IS NULL OR NEW.user_id IS DISTINCT FROM caller_id THEN
    RAISE EXCEPTION 'Pod owner must match the authenticated user';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Pod ownership cannot be changed';
    END IF;
    -- Existing active pods remain editable after a downgrade. Only creation
    -- or reactivation consumes another slot.
    IF OLD.status <> 'archived' OR NEW.status = 'archived' THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.status = 'archived' THEN
    RETURN NEW;
  END IF;

  -- Serialize slot acquisition for the same customer, including reactivation.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.user_id::TEXT, 47));
  SELECT CASE subscription.tier
    WHEN 'starter' THEN 1 WHEN 'growth' THEN 3 WHEN 'pro' THEN 7 WHEN 'scale' THEN 12 ELSE 1
  END INTO plan_limit
  FROM public.subscriptions subscription
  WHERE subscription.user_id = NEW.user_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.current_period_end > now();
  plan_limit := COALESCE(plan_limit, 1);

  SELECT COUNT(*) INTO active_count
  FROM public.pods pod
  WHERE pod.user_id = NEW.user_id
    AND pod.status <> 'archived'
    AND pod.id IS DISTINCT FROM NEW.id;
  IF active_count >= plan_limit THEN
    RAISE EXCEPTION 'Pod limit reached for this plan (% active pods)', plan_limit;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_pod_limit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_pod_limit_before_insert ON public.pods;
DROP TRIGGER IF EXISTS enforce_pod_limit_before_write ON public.pods;
CREATE TRIGGER enforce_pod_limit_before_write
BEFORE INSERT OR UPDATE OF user_id, status ON public.pods
FOR EACH ROW EXECUTE FUNCTION private.enforce_pod_limit();

-- A source/asset row belongs permanently to its original pod. Checking only
-- NEW.pod_id in the existing brand-lock triggers permits moving a locked row
-- into an unlocked pod. Deny reassignment before those existing checks run.
CREATE OR REPLACE FUNCTION private.enforce_pod_child_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.pod_id IS DISTINCT FROM OLD.pod_id THEN
    RAISE EXCEPTION 'Pod sources and assets cannot be moved to another pod.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.enforce_pod_child_identity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_pod_source_identity ON public.pod_sources;
CREATE TRIGGER enforce_pod_source_identity
BEFORE UPDATE OF pod_id ON public.pod_sources
FOR EACH ROW EXECUTE FUNCTION private.enforce_pod_child_identity();
DROP TRIGGER IF EXISTS enforce_pod_asset_identity ON public.pod_assets;
CREATE TRIGGER enforce_pod_asset_identity
BEFORE UPDATE OF pod_id ON public.pod_assets
FOR EACH ROW EXECUTE FUNCTION private.enforce_pod_child_identity();

-- The row locks above also need to cover the underlying image bytes. These
-- restrictive guards complement, rather than replace, existing owner policies.
-- Reading/signing locked inputs remains allowed; campaign objects and unlocked
-- brand uploads keep their existing permissions. Guard both UPDATE images so a
-- new object cannot be renamed over a protected path.
CREATE INDEX IF NOT EXISTS pod_assets_locked_brand_path_idx
  ON public.pod_assets (storage_path, pod_id)
  WHERE asset_role IN ('logo', 'brand_photo');

DROP POLICY IF EXISTS pod_brand_inputs_immutable_insert ON storage.objects;
CREATE POLICY pod_brand_inputs_immutable_insert ON storage.objects
AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  bucket_id <> 'pod-assets' OR NOT EXISTS (
    SELECT 1 FROM public.pod_assets asset
    JOIN public.pods pod ON pod.id = asset.pod_id
    WHERE asset.storage_path = storage.objects.name
      AND asset.asset_role IN ('logo', 'brand_photo')
      AND pod.source_locked_at IS NOT NULL
  )
);

DROP POLICY IF EXISTS pod_brand_inputs_immutable_delete ON storage.objects;
CREATE POLICY pod_brand_inputs_immutable_delete ON storage.objects
AS RESTRICTIVE FOR DELETE TO authenticated
USING (
  bucket_id <> 'pod-assets' OR NOT EXISTS (
    SELECT 1 FROM public.pod_assets asset
    JOIN public.pods pod ON pod.id = asset.pod_id
    WHERE asset.storage_path = storage.objects.name
      AND asset.asset_role IN ('logo', 'brand_photo')
      AND pod.source_locked_at IS NOT NULL
  )
);

DROP POLICY IF EXISTS pod_brand_inputs_immutable_update ON storage.objects;
CREATE POLICY pod_brand_inputs_immutable_update ON storage.objects
AS RESTRICTIVE FOR UPDATE TO authenticated
USING (
  bucket_id <> 'pod-assets' OR NOT EXISTS (
    SELECT 1 FROM public.pod_assets asset
    JOIN public.pods pod ON pod.id = asset.pod_id
    WHERE asset.storage_path = storage.objects.name
      AND asset.asset_role IN ('logo', 'brand_photo')
      AND pod.source_locked_at IS NOT NULL
  )
)
WITH CHECK (
  bucket_id <> 'pod-assets' OR NOT EXISTS (
    SELECT 1 FROM public.pod_assets asset
    JOIN public.pods pod ON pod.id = asset.pod_id
    WHERE asset.storage_path = storage.objects.name
      AND asset.asset_role IN ('logo', 'brand_photo')
      AND pod.source_locked_at IS NOT NULL
  )
);

ALTER TABLE public.pod_analysis
  ADD COLUMN IF NOT EXISTS brand_colours JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS geography JSONB NOT NULL DEFAULT '[]'::JSONB;

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
  SELECT * INTO pod_row
  FROM public.pods p
  WHERE p.id = p_pod_id AND p.user_id = (SELECT auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pod not found or not owned by the signed-in user.';
  END IF;
  IF pod_row.source_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This pod has already been analysed and its source is locked.';
  END IF;
  IF pod_row.source_type IS NULL OR pod_row.source_type NOT IN ('website', 'social', 'shopify', 'photos') THEN
    RAISE EXCEPTION 'Choose one supported primary source type before running analysis.';
  END IF;
  IF pod_row.source_type IN ('website', 'social', 'shopify')
    AND NULLIF(BTRIM(COALESCE(pod_row.source_url, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Add one primary URL before running analysis.';
  END IF;
  IF pod_row.source_type = 'photos' AND NOT EXISTS (
    SELECT 1 FROM public.pod_assets pa WHERE pa.pod_id = p_pod_id AND pa.asset_role = 'brand_photo'
  ) THEN
    RAISE EXCEPTION 'Add at least one brand photo before running analysis.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pod_assets pa WHERE pa.pod_id = p_pod_id AND pa.asset_role = 'logo'
  ) THEN
    RAISE EXCEPTION 'Add the brand logo before running analysis.';
  END IF;
  IF jsonb_typeof(p_analysis) IS DISTINCT FROM 'object'
    OR jsonb_typeof(COALESCE(p_analysis->'brand_colours', '[]'::JSONB)) IS DISTINCT FROM 'array'
    OR jsonb_typeof(COALESCE(p_analysis->'geography', '[]'::JSONB)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Analysis must contain valid colour and geography lists.';
  END IF;

  INSERT INTO public.pod_analysis (
    pod_id, brand_summary, tone, audience, offer_direction, campaign_angles,
    social_recommendations, content_ideas, brand_colours, geography, evidence, confidence,
    source_captured_at, personal_data_detected, personal_data_categories, updated_at
  ) VALUES (
    p_pod_id, p_analysis->>'summary', p_analysis->>'tone', p_analysis->>'audience',
    p_analysis->>'offer', p_analysis->>'opportunity',
    COALESCE(p_analysis->'platforms', '[]'::JSONB)::TEXT,
    COALESCE(p_analysis->'pillars', '[]'::JSONB)::TEXT,
    COALESCE(p_analysis->'brand_colours', '[]'::JSONB),
    COALESCE(p_analysis->'geography', '[]'::JSONB),
    COALESCE(p_analysis->'evidence', '[]'::JSONB), (p_analysis->>'confidence')::NUMERIC,
    (p_analysis->>'source_captured_at')::TIMESTAMPTZ,
    COALESCE((p_analysis->>'personal_data_detected')::BOOLEAN, false),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_analysis->'personal_data_categories', '[]'::JSONB))), NOW()
  )
  ON CONFLICT (pod_id) DO UPDATE SET
    brand_summary = EXCLUDED.brand_summary, tone = EXCLUDED.tone,
    audience = EXCLUDED.audience, offer_direction = EXCLUDED.offer_direction,
    campaign_angles = EXCLUDED.campaign_angles,
    social_recommendations = EXCLUDED.social_recommendations,
    content_ideas = EXCLUDED.content_ideas, brand_colours = EXCLUDED.brand_colours,
    geography = EXCLUDED.geography, evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence,
    source_captured_at = EXCLUDED.source_captured_at, personal_data_detected = EXCLUDED.personal_data_detected,
    personal_data_categories = EXCLUDED.personal_data_categories, updated_at = NOW();

  UPDATE public.pods
  SET source_locked_at = COALESCE(source_locked_at, NOW()),
      status = 'awaiting_direction', updated_at = NOW()
  WHERE id = p_pod_id
  RETURNING source_locked_at INTO locked_at;
  RETURN locked_at;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_pod_analysis(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_pod_analysis(UUID, JSONB) TO authenticated;

CREATE INDEX IF NOT EXISTS pod_preferences_latest_active_type_idx
  ON public.pod_preferences (pod_id, preference_type, created_at DESC, id DESC)
  WHERE active;

-- Selecting the newest row per type keeps repeated platform selections from
-- hiding a customer's substantive direction. Invoker security retains RLS.
CREATE OR REPLACE FUNCTION public.get_latest_pod_preferences(p_pod_id UUID)
RETURNS TABLE (preference_type TEXT, preference_value JSONB, created_at TIMESTAMPTZ)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT recent.preference_type, recent.preference_value, recent.created_at
  FROM (
    SELECT latest.preference_type, latest.preference_value, latest.created_at
    FROM (
      SELECT DISTINCT ON (preference.preference_type)
        preference.preference_type, preference.preference_value, preference.created_at, preference.id
      FROM public.pod_preferences preference
      JOIN public.pods pod ON pod.id = preference.pod_id
      WHERE preference.pod_id = p_pod_id AND preference.active
        AND pod.user_id = (SELECT auth.uid())
      ORDER BY preference.preference_type, preference.created_at DESC, preference.id DESC
    ) latest
    ORDER BY latest.created_at DESC, latest.id DESC
    LIMIT 20
  ) recent
  ORDER BY recent.created_at ASC, recent.preference_type;
$$;
REVOKE ALL ON FUNCTION public.get_latest_pod_preferences(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_latest_pod_preferences(UUID) TO authenticated;


