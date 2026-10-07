-- One pod is permanently tied to one primary brand source after its first analysis.
-- Initial brand inputs are one URL (website, social page, or Shopify), or photos,
-- plus one logo and no more than five brand photos.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

ALTER TABLE public.pods
  ADD COLUMN IF NOT EXISTS source_locked_at TIMESTAMPTZ;

ALTER TABLE public.pod_assets
  ADD COLUMN IF NOT EXISTS asset_role TEXT NOT NULL DEFAULT 'campaign_asset';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pod_assets_asset_role_check'
      AND conrelid = 'public.pod_assets'::regclass
  ) THEN
    ALTER TABLE public.pod_assets
      ADD CONSTRAINT pod_assets_asset_role_check
      CHECK (asset_role IN ('logo', 'brand_photo', 'campaign_asset'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pod_assets_one_logo_idx
  ON public.pod_assets (pod_id)
  WHERE asset_role = 'logo';

CREATE OR REPLACE FUNCTION private.enforce_pod_primary_source()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.source_locked_at IS NOT NULL
    AND (
      NEW.source_url IS DISTINCT FROM OLD.source_url
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_locked_at IS DISTINCT FROM OLD.source_locked_at
    )
  THEN
    RAISE EXCEPTION 'This pod source is locked. Create another pod for a different brand source.';
  END IF;

  IF NEW.source_type IN ('website', 'social', 'shopify')
    AND NULLIF(BTRIM(COALESCE(NEW.source_url, '')), '') IS NULL
  THEN
    RAISE EXCEPTION 'This source type requires one URL.';
  END IF;

  IF NEW.source_type = 'photos'
    AND NULLIF(BTRIM(COALESCE(NEW.source_url, '')), '') IS NOT NULL
  THEN
    RAISE EXCEPTION 'A photos-only source cannot also store a primary URL.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_pod_primary_source ON public.pods;
CREATE TRIGGER enforce_pod_primary_source
BEFORE INSERT OR UPDATE ON public.pods
FOR EACH ROW EXECUTE FUNCTION private.enforce_pod_primary_source();

CREATE OR REPLACE FUNCTION private.enforce_single_pod_source_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  target_pod_id UUID;
  target_source_type TEXT;
  previous_source_type TEXT;
  locked_at TIMESTAMPTZ;
  other_primary_sources INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_pod_id := OLD.pod_id;
    target_source_type := OLD.source_type;
    previous_source_type := OLD.source_type;
  ELSE
    target_pod_id := NEW.pod_id;
    target_source_type := NEW.source_type;
    IF TG_OP = 'UPDATE' THEN previous_source_type := OLD.source_type; END IF;
  END IF;

  IF target_source_type NOT IN ('website', 'social', 'shopify')
    AND COALESCE(previous_source_type, '') NOT IN ('website', 'social', 'shopify')
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT p.source_locked_at INTO locked_at
  FROM public.pods p
  WHERE p.id = target_pod_id;

  IF locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This pod source is locked. Create another pod for a different brand source.';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_pod_id::TEXT, 0));
    SELECT COUNT(*) INTO other_primary_sources
    FROM public.pod_sources ps
    WHERE ps.pod_id = target_pod_id
      AND ps.source_type IN ('website', 'social', 'shopify')
      AND NULLIF(BTRIM(COALESCE(ps.source_url, '')), '') IS NOT NULL
      AND (TG_OP = 'INSERT' OR ps.id <> NEW.id);

    IF other_primary_sources >= 1 THEN
      RAISE EXCEPTION 'A pod can have only one primary website, social page, or Shopify source.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_single_pod_source_row ON public.pod_sources;
CREATE TRIGGER enforce_single_pod_source_row
BEFORE INSERT OR UPDATE OR DELETE ON public.pod_sources
FOR EACH ROW EXECUTE FUNCTION private.enforce_single_pod_source_row();

CREATE OR REPLACE FUNCTION private.enforce_pod_brand_asset_limits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  target_pod_id UUID;
  target_role TEXT;
  previous_role TEXT;
  locked_at TIMESTAMPTZ;
  role_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_pod_id := OLD.pod_id;
    target_role := OLD.asset_role;
    previous_role := OLD.asset_role;
  ELSE
    target_pod_id := NEW.pod_id;
    target_role := NEW.asset_role;
    IF TG_OP = 'UPDATE' THEN previous_role := OLD.asset_role; END IF;
  END IF;

  IF target_role NOT IN ('logo', 'brand_photo')
    AND COALESCE(previous_role, '') NOT IN ('logo', 'brand_photo')
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT p.source_locked_at INTO locked_at
  FROM public.pods p
  WHERE p.id = target_pod_id;

  IF locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Brand-analysis images are locked for this pod.';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_pod_id::TEXT, 1));
    SELECT COUNT(*) INTO role_count
    FROM public.pod_assets pa
    WHERE pa.pod_id = target_pod_id
      AND pa.asset_role = target_role
      AND (TG_OP = 'INSERT' OR pa.id <> NEW.id);

    IF target_role = 'logo' AND role_count >= 1 THEN
      RAISE EXCEPTION 'A pod can have only one brand logo.';
    END IF;
    IF target_role = 'brand_photo' AND role_count >= 5 THEN
      RAISE EXCEPTION 'A pod can have no more than five brand photos for analysis.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_pod_brand_asset_limits ON public.pod_assets;
CREATE TRIGGER enforce_pod_brand_asset_limits
BEFORE INSERT OR UPDATE OR DELETE ON public.pod_assets
FOR EACH ROW EXECUTE FUNCTION private.enforce_pod_brand_asset_limits();

CREATE OR REPLACE FUNCTION public.finalize_pod_analysis(
  p_pod_id UUID,
  p_analysis JSONB
)
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
  WHERE p.id = p_pod_id
    AND p.user_id = (SELECT auth.uid())
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pod not found or not owned by the signed-in user.';
  END IF;

  IF pod_row.source_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This pod has already been analysed and its source is locked.';
  END IF;

  IF pod_row.source_type IS NULL
    OR pod_row.source_type NOT IN ('website', 'social', 'shopify', 'photos')
  THEN
    RAISE EXCEPTION 'Choose one supported primary source type before running analysis.';
  END IF;

  IF pod_row.source_type IN ('website', 'social', 'shopify')
    AND NULLIF(BTRIM(COALESCE(pod_row.source_url, '')), '') IS NULL
  THEN
    RAISE EXCEPTION 'Add one primary URL before running analysis.';
  END IF;

  IF pod_row.source_type = 'photos'
    AND NOT EXISTS (
      SELECT 1 FROM public.pod_assets pa
      WHERE pa.pod_id = p_pod_id AND pa.asset_role = 'brand_photo'
    )
  THEN
    RAISE EXCEPTION 'Add at least one brand photo before running analysis.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.pod_assets pa
    WHERE pa.pod_id = p_pod_id AND pa.asset_role = 'logo'
  ) THEN
    RAISE EXCEPTION 'Add the brand logo before running analysis.';
  END IF;

  INSERT INTO public.pod_analysis (
    pod_id,
    brand_summary,
    tone,
    audience,
    offer_direction,
    campaign_angles,
    social_recommendations,
    content_ideas,
    updated_at
  ) VALUES (
    p_pod_id,
    p_analysis->>'summary',
    p_analysis->>'tone',
    p_analysis->>'audience',
    p_analysis->>'offer',
    p_analysis->>'opportunity',
    COALESCE(p_analysis->'platforms', '[]'::JSONB)::TEXT,
    COALESCE(p_analysis->'pillars', '[]'::JSONB)::TEXT,
    NOW()
  )
  ON CONFLICT (pod_id) DO UPDATE SET
    brand_summary = EXCLUDED.brand_summary,
    tone = EXCLUDED.tone,
    audience = EXCLUDED.audience,
    offer_direction = EXCLUDED.offer_direction,
    campaign_angles = EXCLUDED.campaign_angles,
    social_recommendations = EXCLUDED.social_recommendations,
    content_ideas = EXCLUDED.content_ideas,
    updated_at = NOW();

  UPDATE public.pods
  SET source_locked_at = COALESCE(source_locked_at, NOW()),
      status = 'awaiting_direction',
      updated_at = NOW()
  WHERE id = p_pod_id
  RETURNING source_locked_at INTO locked_at;

  RETURN locked_at;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_pod_analysis(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_pod_analysis(UUID, JSONB) TO authenticated;

