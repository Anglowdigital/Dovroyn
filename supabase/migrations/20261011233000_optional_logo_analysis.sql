-- Logos are optional for source analysis. Preserve all ownership, source-lock,
-- source-type and photos-only guards from the reconciled production function.
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

