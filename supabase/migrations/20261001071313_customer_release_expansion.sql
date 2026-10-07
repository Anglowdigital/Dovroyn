-- Forward expansion: retains legacy API permissions until the cutover migration.
-- Requires existing base/workspace/source-lock schema and onboarding reconciliation.
-- New publishing RPCs remain disabled for service_role until all write guards are installed.
BEGIN;
-- A generation attempt can fail only itself, never another request's successful content day.

REVOKE ALL ON TABLE public.generation_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.generation_usage TO authenticated;
ALTER TABLE public.generation_usage ENABLE ROW LEVEL SECURITY;

-- Legacy entry points remain available until the coordinated cutover.

CREATE TABLE IF NOT EXISTS private.content_generation_days (
  usage_id UUID NOT NULL REFERENCES public.generation_usage(id) ON DELETE CASCADE,
  generation_date DATE NOT NULL,
  protected BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (usage_id, generation_date)
);
CREATE TABLE IF NOT EXISTS private.content_generation_attempts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  usage_id UUID NOT NULL,
  generation_date DATE NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (usage_id, generation_date) REFERENCES private.content_generation_days(usage_id, generation_date) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS content_generation_attempts_day_idx ON private.content_generation_attempts(usage_id, generation_date);
ALTER TABLE private.content_generation_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.content_generation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.content_generation_days, private.content_generation_attempts FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_content_day_server(
  p_user_id UUID, p_pod_id UUID, p_generation_date DATE, p_attempt_id UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET TimeZone = 'UTC' AS $$
DECLARE
  subscription public.subscriptions%ROWTYPE;
  usage public.generation_usage%ROWTYPE;
  prior private.content_generation_attempts%ROWTYPE;
  anchor_date DATE;
  month_start DATE;
  next_month_start DATE;
  allowance_start DATE;
  allowance_end DATE;
  anchor_day INTEGER;
  day_limit INTEGER;
  already_reserved BOOLEAN;
BEGIN
  IF p_user_id IS NULL OR p_generation_date IS NULL OR p_attempt_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = p_user_id
      AND pod.status IN ('direction_locked', 'active')
  ) THEN RAISE EXCEPTION 'An owned pod with approved direction is required'; END IF;

  -- Shared with completion/failure. Serializes a date's reserve/refund/recreate sequence.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_pod_id::TEXT, 93));
  SELECT * INTO subscription FROM public.subscriptions item
    WHERE item.user_id = p_user_id AND item.status IN ('active', 'trialing') AND item.current_period_end > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Active subscription required'; END IF;
  day_limit := CASE subscription.tier WHEN 'starter' THEN 10 WHEN 'growth' THEN 20 WHEN 'pro' THEN 30 WHEN 'scale' THEN 30 ELSE 0 END;
  IF day_limit = 0 THEN RAISE EXCEPTION 'Active paid subscription required'; END IF;
  anchor_date := COALESCE(subscription.subscription_started_at, subscription.current_period_start, subscription.created_at)::DATE;
  anchor_day := extract(day FROM anchor_date)::INTEGER;
  month_start := date_trunc('month', timezone('UTC', now()))::DATE;
  allowance_start := month_start + (least(anchor_day, extract(day FROM (month_start + interval '1 month - 1 day'))::INTEGER) - 1);
  IF timezone('UTC', now())::DATE < allowance_start THEN
    month_start := (month_start - interval '1 month')::DATE;
    allowance_start := month_start + (least(anchor_day, extract(day FROM (month_start + interval '1 month - 1 day'))::INTEGER) - 1);
  END IF;
  next_month_start := (month_start + interval '1 month')::DATE;
  allowance_end := next_month_start + (least(anchor_day, extract(day FROM (next_month_start + interval '1 month - 1 day'))::INTEGER) - 1);
  IF p_generation_date < allowance_start OR p_generation_date >= allowance_end THEN
    RETURN jsonb_build_object('allowed', FALSE, 'reason', 'outside_allowance_period', 'startsOn', allowance_start, 'endsOn', allowance_end);
  END IF;

  INSERT INTO public.generation_usage(user_id, pod_id, allowance_starts_at, allowance_ends_at, content_days_generated, generated_dates)
    VALUES (p_user_id, p_pod_id, allowance_start::TIMESTAMPTZ, allowance_end::TIMESTAMPTZ, 0, '{}')
    ON CONFLICT (pod_id, allowance_starts_at) DO NOTHING;
  SELECT * INTO usage FROM public.generation_usage item
    WHERE item.pod_id = p_pod_id AND item.allowance_starts_at = allowance_start::TIMESTAMPTZ FOR UPDATE;
  IF usage.user_id IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'Content allowance ownership mismatch'; END IF;

  SELECT * INTO prior FROM private.content_generation_attempts WHERE id = p_attempt_id;
  IF FOUND THEN
    IF prior.user_id IS DISTINCT FROM p_user_id OR prior.pod_id IS DISTINCT FROM p_pod_id
      OR prior.generation_date IS DISTINCT FROM p_generation_date OR prior.usage_id IS DISTINCT FROM usage.id THEN
      RAISE EXCEPTION 'Generation attempt mismatch';
    END IF;
    IF prior.state <> 'pending' THEN RAISE EXCEPTION 'Generation attempt already completed'; END IF;
    RETURN jsonb_build_object('allowed', TRUE, 'used', usage.content_days_generated, 'limit', day_limit, 'alreadyReserved', TRUE, 'attemptId', p_attempt_id);
  END IF;

  already_reserved := p_generation_date = ANY(usage.generated_dates);
  IF NOT already_reserved AND usage.content_days_generated >= day_limit THEN
    RETURN jsonb_build_object('allowed', FALSE, 'reason', 'monthly_content_days_reached', 'used', usage.content_days_generated, 'limit', day_limit);
  END IF;
  -- Existing legacy dates have no attempt provenance: retain them permanently.
  INSERT INTO private.content_generation_days(usage_id, generation_date, protected)
    VALUES (usage.id, p_generation_date, already_reserved) ON CONFLICT DO NOTHING;
  IF NOT already_reserved THEN
    UPDATE public.generation_usage SET generated_dates = array_append(generated_dates, p_generation_date),
      content_days_generated = content_days_generated + 1, updated_at = now() WHERE id = usage.id;
  END IF;
  INSERT INTO private.content_generation_attempts(id, user_id, pod_id, usage_id, generation_date)
    VALUES (p_attempt_id, p_user_id, p_pod_id, usage.id, p_generation_date);
  RETURN jsonb_build_object('allowed', TRUE, 'used', usage.content_days_generated + CASE WHEN already_reserved THEN 0 ELSE 1 END,
    'limit', day_limit, 'alreadyReserved', already_reserved, 'attemptId', p_attempt_id);
END;
$$;

CREATE OR REPLACE FUNCTION private.finish_content_generation_attempt(
  p_user_id UUID, p_pod_id UUID, p_generation_date DATE, p_attempt_id UUID, p_succeeded BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  attempt private.content_generation_attempts%ROWTYPE;
  day_protected BOOLEAN;
BEGIN
  IF p_user_id IS NULL OR p_generation_date IS NULL OR p_attempt_id IS NULL OR p_succeeded IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = p_user_id
  ) THEN RAISE EXCEPTION 'Pod not found'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_pod_id::TEXT, 93));
  SELECT * INTO attempt FROM private.content_generation_attempts WHERE id = p_attempt_id;
  IF NOT FOUND OR attempt.user_id IS DISTINCT FROM p_user_id OR attempt.pod_id IS DISTINCT FROM p_pod_id
    OR attempt.generation_date IS DISTINCT FROM p_generation_date THEN RAISE EXCEPTION 'Generation attempt mismatch'; END IF;
  -- Terminal attempts are immutable. A stale failure can never refund a later reservation.
  IF attempt.state <> 'pending' THEN
    IF p_succeeded AND attempt.state = 'failed' THEN RAISE EXCEPTION 'Generation attempt already failed'; END IF;
    RETURN;
  END IF;
  PERFORM 1 FROM public.generation_usage WHERE id = attempt.usage_id FOR UPDATE;
  UPDATE private.content_generation_attempts SET state = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
    completed_at = now() WHERE id = p_attempt_id;
  IF p_succeeded THEN
    UPDATE private.content_generation_days SET protected = TRUE WHERE usage_id = attempt.usage_id AND generation_date = p_generation_date;
    RETURN;
  END IF;
  SELECT protected INTO day_protected FROM private.content_generation_days WHERE usage_id = attempt.usage_id AND generation_date = p_generation_date;
  IF NOT day_protected AND NOT EXISTS (
    SELECT 1 FROM private.content_generation_attempts other WHERE other.usage_id = attempt.usage_id
      AND other.generation_date = p_generation_date AND other.state IN ('pending', 'succeeded')
  ) THEN
    UPDATE public.generation_usage SET generated_dates = array_remove(generated_dates, p_generation_date),
      content_days_generated = greatest(0, content_days_generated - 1), updated_at = now()
      WHERE id = attempt.usage_id AND p_generation_date = ANY(generated_dates);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_content_day_server(p_user_id UUID, p_pod_id UUID, p_generation_date DATE, p_attempt_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.finish_content_generation_attempt(p_user_id, p_pod_id, p_generation_date, p_attempt_id, TRUE);
$$;
CREATE OR REPLACE FUNCTION public.release_content_day_server(p_user_id UUID, p_pod_id UUID, p_generation_date DATE, p_attempt_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.finish_content_generation_attempt(p_user_id, p_pod_id, p_generation_date, p_attempt_id, FALSE);
$$;

REVOKE ALL ON FUNCTION private.finish_content_generation_attempt(UUID, UUID, DATE, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_content_day_server(UUID, UUID, DATE, UUID), public.complete_content_day_server(UUID, UUID, DATE, UUID), public.release_content_day_server(UUID, UUID, DATE, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_content_day_server(UUID, UUID, DATE, UUID), public.complete_content_day_server(UUID, UUID, DATE, UUID), public.release_content_day_server(UUID, UUID, DATE, UUID) TO service_role;


-- Instagram OAuth persistence for the serverless start/callback routes.
-- Service-only OAuth functions become available during expansion.


CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

-- OAuth connection status and permission grants are provider-verified facts.
-- Existing browser writes remain available until the cutover enables the publisher.
GRANT SELECT ON public.social_connections TO authenticated;
REVOKE ALL ON private.social_credentials FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.instagram_oauth_states (
  state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 10 AND 2048),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_oauth_states_expiry_idx
  ON private.instagram_oauth_states (expires_at);

ALTER TABLE private.instagram_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.instagram_oauth_states FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_instagram_oauth_state(
  p_state_hash TEXT,
  p_user_id UUID,
  p_pod_id UUID,
  p_redirect_uri TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid OAuth state hash';
  END IF;
  IF p_redirect_uri IS NULL
    OR p_redirect_uri !~ '^https://'
    OR length(p_redirect_uri) > 2048 THEN
    RAISE EXCEPTION 'Invalid OAuth redirect URI';
  END IF;
  IF p_expires_at IS NULL
    OR p_expires_at <= now()
    OR p_expires_at > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'Invalid OAuth state expiry';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.pods pod
    WHERE pod.id = p_pod_id
      AND pod.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;

  DELETE FROM private.instagram_oauth_states
  WHERE expires_at <= now();

  INSERT INTO private.instagram_oauth_states (
    state_hash,
    user_id,
    pod_id,
    redirect_uri,
    expires_at
  )
  VALUES (
    p_state_hash,
    p_user_id,
    p_pod_id,
    p_redirect_uri,
    p_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_instagram_oauth_state(
  p_state_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  consumed private.instagram_oauth_states%ROWTYPE;
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN NULL;
  END IF;

  DELETE FROM private.instagram_oauth_states oauth_state
  WHERE oauth_state.state_hash = p_state_hash
    AND oauth_state.expires_at > now()
  RETURNING * INTO consumed;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'user_id', consumed.user_id,
    'pod_id', consumed.pod_id,
    'redirect_uri', consumed.redirect_uri
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.store_instagram_connection(
  p_user_id UUID,
  p_pod_id UUID,
  p_provider_account_id TEXT,
  p_account_label TEXT,
  p_granted_scopes TEXT[],
  p_expires_at TIMESTAMPTZ,
  p_encrypted_access_token TEXT,
  p_encryption_key_version TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_connection_id UUID;
  required_scopes CONSTANT TEXT[] := ARRAY[
    'instagram_business_basic',
    'instagram_business_content_publish'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.pods pod
    WHERE pod.id = p_pod_id
      AND pod.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;
  IF p_provider_account_id IS NULL OR p_provider_account_id !~ '^\d{1,32}$' THEN
    RAISE EXCEPTION 'Invalid Instagram account ID';
  END IF;
  IF p_account_label IS NULL OR length(trim(p_account_label)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid Instagram account label';
  END IF;
  IF p_granted_scopes IS NULL
    OR NOT (p_granted_scopes @> required_scopes)
    OR cardinality(p_granted_scopes) > 64
    OR EXISTS (
      SELECT 1 FROM unnest(p_granted_scopes) scope
      WHERE scope IS NULL OR scope !~ '^[a-z][a-z0-9_]{0,127}$'
    ) THEN
    RAISE EXCEPTION 'Invalid Instagram scopes';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Instagram token is already expired';
  END IF;
  IF p_encrypted_access_token IS NULL
    OR length(p_encrypted_access_token) NOT BETWEEN 1 AND 65536
    OR p_encrypted_access_token !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid encrypted Instagram token';
  END IF;
  IF p_encryption_key_version IS NULL
    OR p_encryption_key_version !~ '^[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'Invalid encryption key version';
  END IF;

  INSERT INTO public.social_connections (
    pod_id,
    provider,
    provider_account_id,
    account_label,
    status,
    granted_scopes,
    connected_at,
    expires_at,
    last_error,
    updated_at
  )
  VALUES (
    p_pod_id,
    'instagram',
    p_provider_account_id,
    p_account_label,
    'connected',
    p_granted_scopes,
    now(),
    p_expires_at,
    NULL,
    now()
  )
  ON CONFLICT (pod_id, provider, provider_account_id)
  DO UPDATE SET
    account_label = EXCLUDED.account_label,
    status = 'connected',
    granted_scopes = EXCLUDED.granted_scopes,
    connected_at = now(),
    expires_at = EXCLUDED.expires_at,
    last_error = NULL,
    updated_at = now()
  RETURNING id INTO target_connection_id;

  INSERT INTO private.social_credentials (
    connection_id,
    encrypted_access_token,
    encrypted_refresh_token,
    encryption_key_version,
    updated_at
  )
  VALUES (
    target_connection_id,
    convert_to(p_encrypted_access_token, 'UTF8'),
    NULL,
    p_encryption_key_version,
    now()
  )
  ON CONFLICT (connection_id)
  DO UPDATE SET
    encrypted_access_token = EXCLUDED.encrypted_access_token,
    encrypted_refresh_token = NULL,
    encryption_key_version = EXCLUDED.encryption_key_version,
    updated_at = now();

  RETURN target_connection_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_instagram_oauth_state(
  TEXT, UUID, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_instagram_oauth_state(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_instagram_connection(
  UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

-- Enable OAuth only at cutover, after browser connection writes are revoked.
REVOKE ALL ON FUNCTION public.create_instagram_oauth_state(
  TEXT, UUID, UUID, TEXT, TIMESTAMPTZ
) FROM service_role;
REVOKE ALL ON FUNCTION public.consume_instagram_oauth_state(TEXT)
  FROM service_role;
REVOKE ALL ON FUNCTION public.store_instagram_connection(
  UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TEXT, TEXT
) FROM service_role;


-- Reviewed code only. Apply after base, workspace, source-lock and Instagram OAuth migrations.
-- Immediate, explicitly confirmed single-image publication; this does not start a scheduler.

ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS provider_permalink TEXT;

CREATE TABLE private.instagram_publish_attempts (
  post_id UUID PRIMARY KEY REFERENCES public.social_posts(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE RESTRICT,
  connection_id UUID NOT NULL REFERENCES public.social_connections(id) ON DELETE RESTRICT,
  asset_id UUID NOT NULL REFERENCES public.pod_assets(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  caption TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  accepted_tone TEXT NOT NULL,
  accepted_strategy TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing','processing','ready','publishing','published','failed','unknown')),
  operation_id UUID NOT NULL,
  container_id TEXT CHECK (container_id ~ '^[1-9][0-9]{0,31}$'),
  container_status TEXT CHECK (container_status IN ('IN_PROGRESS','FINISHED','ERROR','EXPIRED','PUBLISHED')),
  media_id TEXT CHECK (media_id ~ '^[1-9][0-9]{0,31}$'),
  permalink TEXT,
  error_code TEXT,
  posting_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE private.instagram_publish_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.instagram_publish_attempts FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX instagram_publish_days_idx ON private.instagram_publish_attempts(pod_id,posting_date);

-- Direct browser writes remain available for drafts only. Provider facts and any
-- post already claimed for publication can only be changed by trusted functions.
CREATE OR REPLACE FUNCTION private.guard_social_publish_facts()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user NOT IN ('anon','authenticated') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.status NOT IN ('draft','approved') THEN
    RAISE EXCEPTION 'Published or claimed posts cannot be edited or deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.status NOT IN ('draft','approved') OR NEW.published_at IS NOT NULL
    OR NEW.provider_post_id IS NOT NULL OR NEW.provider_permalink IS NOT NULL THEN
    RAISE EXCEPTION 'Publishing facts are server controlled';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.pod_id <> OLD.pod_id) THEN
    RAISE EXCEPTION 'A saved post cannot be moved';
  END IF;
  -- A caller cannot retain an old confirmation timestamp while changing content.
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;

-- Freeze the actual selected object while Meta can still fetch it. Metadata
-- ownership and file type are verified again at the publication boundary.
CREATE OR REPLACE FUNCTION private.guard_instagram_pending_asset()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_SCHEMA = 'storage' THEN
    IF OLD.bucket_id = 'pod-assets' AND EXISTS (
      SELECT 1 FROM private.instagram_publish_attempts a WHERE a.storage_path = OLD.name
      AND a.state IN ('preparing','processing','ready','publishing','unknown')
    ) THEN RAISE EXCEPTION 'An Instagram publication is using this asset'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM private.instagram_publish_attempts a WHERE a.asset_id = OLD.id
      AND a.state IN ('preparing','processing','ready','publishing','unknown')) THEN
      RAISE EXCEPTION 'An Instagram publication is using this asset';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.instagram_publish_allowed(p_user_id UUID,p_post_id UUID,p_connection_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  post public.social_posts%ROWTYPE;
  pod public.pods%ROWTYPE;
  subscription public.subscriptions%ROWTYPE;
  asset public.pod_assets%ROWTYPE;
  connection public.social_connections%ROWTYPE;
  max_pods INTEGER; max_days INTEGER; today DATE; week_start DATE;
  direction_value JSONB; latest_direction TEXT;
BEGIN
  SELECT * INTO post FROM public.social_posts WHERE id=p_post_id FOR UPDATE;
  SELECT * INTO pod FROM public.pods WHERE id=post.pod_id AND user_id=p_user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_NOT_FOUND'; END IF;
  IF post.platform <> 'instagram' OR length(post.body) NOT BETWEEN 1 AND 2200
    OR cardinality(post.media_asset_ids) <> 1 THEN RAISE EXCEPTION 'PUBLISH_DRAFT_INVALID'; END IF;
  IF pod.status NOT IN ('direction_locked','active') OR length(trim(coalesce(pod.accepted_tone,'')))=0
    OR length(trim(coalesce(pod.accepted_strategy,'')))=0 THEN RAISE EXCEPTION 'PUBLISH_DIRECTION_REQUIRED'; END IF;
  SELECT preference_value INTO direction_value FROM public.pod_preferences
    WHERE pod_id=pod.id AND preference_type='brand_direction' AND active
    ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
  IF FOUND THEN
    latest_direction := '';
    IF jsonb_typeof(direction_value)='object' THEN
      latest_direction := btrim(coalesce(direction_value->>'value',''));
    ELSIF jsonb_typeof(direction_value)='string' THEN
      latest_direction := btrim(direction_value #>> '{}');
      BEGIN
        direction_value := latest_direction::JSONB;
        latest_direction := btrim(coalesce(direction_value->>'value',''));
      EXCEPTION WHEN invalid_text_representation THEN
        -- Older rows stored the plain direction as a JSON string.
        NULL;
      END;
    END IF;
    IF latest_direction='' OR latest_direction IS DISTINCT FROM btrim(pod.accepted_tone) THEN
      RAISE EXCEPTION 'PUBLISH_DIRECTION_REQUIRED';
    END IF;
  END IF;
  SELECT * INTO subscription FROM public.subscriptions WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR subscription.status NOT IN ('active','trialing')
    OR subscription.current_period_end IS NULL OR subscription.current_period_end <= now() THEN
    RAISE EXCEPTION 'PUBLISH_PAID_PLAN_REQUIRED';
  END IF;
  max_pods := CASE subscription.tier WHEN 'starter' THEN 1 WHEN 'growth' THEN 3 WHEN 'pro' THEN 7 WHEN 'scale' THEN 12 ELSE 0 END;
  max_days := CASE subscription.tier WHEN 'starter' THEN 2 WHEN 'growth' THEN 3 WHEN 'pro' THEN 6 WHEN 'scale' THEN 7 ELSE 0 END;
  IF max_days=0 THEN RAISE EXCEPTION 'PUBLISH_PAID_PLAN_REQUIRED'; END IF;
  IF (SELECT count(*) FROM public.pods WHERE user_id=p_user_id AND status<>'archived') > max_pods THEN
    RAISE EXCEPTION 'PUBLISH_POD_LIMIT';
  END IF;
  SELECT * INTO asset FROM public.pod_assets WHERE id=post.media_asset_ids[1] AND pod_id=pod.id FOR SHARE;
  IF NOT FOUND OR asset.media_type <> 'image/jpeg' OR asset.file_size IS NULL
    OR asset.file_size NOT BETWEEN 1 AND 8388608
    OR asset.storage_path NOT LIKE p_user_id::text || '/' || pod.id::text || '/%'
    OR asset.storage_path !~* '\.(jpg|jpeg)$'
    OR asset.storage_path ~ '(^|/)\.\.?(/|$)' THEN RAISE EXCEPTION 'PUBLISH_ASSET_INVALID'; END IF;
  PERFORM 1 FROM storage.objects o WHERE o.bucket_id='pod-assets' AND o.name=asset.storage_path
    AND o.owner_id=p_user_id::text AND o.metadata->>'mimetype'='image/jpeg'
    AND o.metadata->>'size' ~ '^[0-9]{1,8}$'
    AND (o.metadata->>'size')::bigint BETWEEN 1 AND 8388608 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ASSET_INVALID'; END IF;
  SELECT * INTO connection FROM public.social_connections WHERE id=p_connection_id AND pod_id=pod.id
    AND provider='instagram' AND status='connected' AND expires_at>now()+interval '1 minute'
    AND granted_scopes @> ARRAY['instagram_business_basic','instagram_business_content_publish'] FOR SHARE;
  IF NOT FOUND OR connection.provider_account_id IS NULL OR connection.provider_account_id !~ '^[1-9][0-9]{0,31}$'
    OR NOT EXISTS (SELECT 1 FROM private.social_credentials WHERE connection_id=connection.id) THEN
    RAISE EXCEPTION 'PUBLISH_CONNECTION_REQUIRED';
  END IF;
  -- Stable Perth calendar boundaries; the caller cannot choose dates/timezones.
  today := (now() AT TIME ZONE 'Australia/Perth')::date;
  week_start := date_trunc('week',today::timestamp)::date;
  IF NOT EXISTS (SELECT 1 FROM private.instagram_publish_attempts WHERE pod_id=pod.id AND posting_date=today
    AND state<>'failed' AND post_id<>p_post_id)
    AND (SELECT count(DISTINCT posting_date) FROM private.instagram_publish_attempts WHERE pod_id=pod.id
      AND posting_date>=week_start AND posting_date<week_start+7 AND state<>'failed' AND post_id<>p_post_id)>=max_days THEN
    RAISE EXCEPTION 'PUBLISH_WEEKLY_LIMIT';
  END IF;
  RETURN jsonb_build_object('podId',pod.id,'assetId',asset.id,'storagePath',asset.storage_path,'caption',post.body,
    'accountId',connection.provider_account_id,'accountLabel',coalesce(connection.account_label,connection.provider_account_id),
    'sourceUpdatedAt',post.updated_at,'tone',pod.accepted_tone,'strategy',pod.accepted_strategy,'postingDate',today);
END;
$$;

CREATE OR REPLACE FUNCTION private.instagram_publish_context(p_user_id UUID,p_post_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a private.instagram_publish_attempts%ROWTYPE; encrypted TEXT;
BEGIN
  SELECT * INTO a FROM private.instagram_publish_attempts WHERE post_id=p_post_id AND user_id=p_user_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.pods WHERE id=a.pod_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'PUBLISH_NOT_FOUND';
  END IF;
  SELECT convert_from(c.encrypted_access_token,'UTF8') INTO encrypted
    FROM private.social_credentials c JOIN public.social_connections s ON s.id=c.connection_id
    WHERE c.connection_id=a.connection_id AND s.provider_account_id=a.account_id AND s.status='connected'
      AND s.expires_at>now()+interval '1 minute'
      AND s.granted_scopes @> ARRAY['instagram_business_basic','instagram_business_content_publish'];
  RETURN jsonb_build_object('postId',a.post_id,'podId',a.pod_id,'state',a.state,'operationId',a.operation_id,
    'containerId',a.container_id,'containerStatus',a.container_status,'mediaId',a.media_id,'permalink',a.permalink,
    'errorCode',a.error_code,'encryptedAccessToken',encrypted,'storagePath',a.storage_path,
    'snapshot',jsonb_build_object('caption',a.caption,'assetId',a.asset_id,'connectionId',a.connection_id,
      'accountLabel',a.account_label,'providerAccountId',a.account_id,'expectedUpdatedAt',a.source_updated_at));
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_instagram_publish(p_user_id UUID,p_pod_id UUID,p_post_id UUID,
  p_connection_id UUID,p_expected_updated_at TIMESTAMPTZ,p_operation_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a private.instagram_publish_attempts%ROWTYPE; details JSONB; post public.social_posts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  SELECT * INTO post FROM public.social_posts WHERE id=p_post_id AND pod_id=p_pod_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.pods WHERE id=p_pod_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'PUBLISH_NOT_FOUND'; END IF;
  SELECT * INTO a FROM private.instagram_publish_attempts WHERE post_id=p_post_id;
  IF FOUND THEN
    IF a.connection_id IS DISTINCT FROM p_connection_id OR a.source_updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'PUBLISH_CONFIRMATION_CHANGED'; END IF;
    RETURN private.instagram_publish_context(p_user_id,p_post_id) || '{"claimed":false}'::jsonb;
  END IF;
  IF post.status NOT IN ('draft','approved') OR post.updated_at IS DISTINCT FROM p_expected_updated_at
    OR p_operation_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_CONFIRMATION_CHANGED'; END IF;
  details := private.instagram_publish_allowed(p_user_id,p_post_id,p_connection_id);
  INSERT INTO private.instagram_publish_attempts(post_id,user_id,pod_id,connection_id,asset_id,account_id,account_label,
    caption,storage_path,source_updated_at,accepted_tone,accepted_strategy,state,operation_id,posting_date)
  VALUES(p_post_id,p_user_id,p_pod_id,p_connection_id,(details->>'assetId')::uuid,details->>'accountId',details->>'accountLabel',
    details->>'caption',details->>'storagePath',post.updated_at,details->>'tone',details->>'strategy','preparing',p_operation_id,
    (details->>'postingDate')::date);
  UPDATE public.social_posts SET status='publishing',updated_at=now() WHERE id=p_post_id;
  RETURN private.instagram_publish_context(p_user_id,p_post_id) || '{"claimed":true}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_instagram_publish(p_user_id UUID,p_pod_id UUID,p_post_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.social_posts s JOIN public.pods p ON p.id=s.pod_id
    WHERE s.id=p_post_id AND p.id=p_pod_id AND p.user_id=p_user_id) THEN RAISE EXCEPTION 'PUBLISH_NOT_FOUND'; END IF;
  -- A terminated worker is never a reason to resend a potentially accepted mutation.
  UPDATE private.instagram_publish_attempts SET state='unknown',error_code='OUTCOME_UNKNOWN',updated_at=now()
    WHERE post_id=p_post_id AND user_id=p_user_id AND state IN ('preparing','publishing')
    AND updated_at<now()-interval '5 minutes';
  RETURN private.instagram_publish_context(p_user_id,p_post_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_instagram_publish(p_user_id UUID,p_post_id UUID,p_operation_id UUID,
  p_event TEXT,p_value TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a private.instagram_publish_attempts%ROWTYPE; details JSONB; allowed BOOLEAN:=false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  SELECT * INTO a FROM private.instagram_publish_attempts WHERE post_id=p_post_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.pods WHERE id=a.pod_id AND user_id=p_user_id) THEN
    RAISE EXCEPTION 'PUBLISH_NOT_FOUND'; END IF;
  IF p_event='container' AND a.state='preparing' AND a.operation_id=p_operation_id AND p_value ~ '^[1-9][0-9]{0,31}$' THEN
    UPDATE private.instagram_publish_attempts SET container_id=p_value,state='processing',updated_at=now() WHERE post_id=p_post_id;
  ELSIF p_event='status' AND a.container_id IS NOT NULL AND p_value IN ('IN_PROGRESS','FINISHED','ERROR','EXPIRED','PUBLISHED') THEN
    UPDATE private.instagram_publish_attempts SET container_status=p_value,
      state=CASE WHEN state='published' THEN state WHEN p_value='PUBLISHED' THEN 'published'
        WHEN state IN ('preparing','processing','ready') AND p_value='FINISHED' THEN 'ready'
        WHEN state IN ('preparing','processing','ready') AND p_value IN ('ERROR','EXPIRED') THEN 'failed' ELSE state END,
      updated_at=now() WHERE post_id=p_post_id;
  ELSIF p_event='begin' AND a.state='ready' AND p_operation_id IS NOT NULL THEN
    details := private.instagram_publish_allowed(p_user_id,p_post_id,a.connection_id);
    IF details->>'tone' IS DISTINCT FROM a.accepted_tone OR details->>'strategy' IS DISTINCT FROM a.accepted_strategy
      OR details->>'caption' IS DISTINCT FROM a.caption OR details->>'storagePath' IS DISTINCT FROM a.storage_path
      OR details->>'accountId' IS DISTINCT FROM a.account_id THEN RAISE EXCEPTION 'PUBLISH_CONFIRMATION_CHANGED'; END IF;
    UPDATE private.instagram_publish_attempts SET state='publishing',operation_id=p_operation_id,
      posting_date=(details->>'postingDate')::date,updated_at=now() WHERE post_id=p_post_id;
    allowed:=true;
  ELSIF p_event='published' AND a.state IN ('publishing','unknown','published') AND a.operation_id=p_operation_id
    AND p_value ~ '^[1-9][0-9]{0,31}$' AND (a.media_id IS NULL OR a.media_id=p_value) THEN
    UPDATE private.instagram_publish_attempts SET state='published',media_id=p_value,error_code=NULL,updated_at=now() WHERE post_id=p_post_id;
  ELSIF p_event='permalink' AND a.state='published' AND a.media_id IS NOT NULL
    AND p_value ~ '^https://(www\.)?instagram\.com/(p|reel|tv)/[A-Za-z0-9_-]+/?$' THEN
    UPDATE private.instagram_publish_attempts SET permalink=p_value,updated_at=now() WHERE post_id=p_post_id;
  ELSIF p_event IN ('failed','unknown') AND a.state IN ('preparing','processing','ready','publishing') AND a.operation_id=p_operation_id THEN
    UPDATE private.instagram_publish_attempts SET state=p_event,error_code=CASE WHEN p_event='unknown' THEN 'OUTCOME_UNKNOWN'
      WHEN p_value='PREPARATION_FAILED' THEN 'PREPARATION_FAILED' ELSE 'PROVIDER_REJECTED' END,
      updated_at=now() WHERE post_id=p_post_id;
  ELSIF p_event<>'begin' THEN
    RAISE EXCEPTION 'PUBLISH_STATE_CONFLICT';
  END IF;
  SELECT * INTO a FROM private.instagram_publish_attempts WHERE post_id=p_post_id;
  UPDATE public.social_posts SET status=CASE WHEN a.state='published' THEN 'published' WHEN a.state='failed' THEN 'failed' ELSE 'publishing' END,
    published_at=CASE WHEN a.state='published' THEN coalesce(published_at,now()) ELSE published_at END,
    provider_post_id=a.media_id,provider_permalink=a.permalink,updated_at=now() WHERE id=p_post_id;
  RETURN private.instagram_publish_context(p_user_id,p_post_id) || jsonb_build_object('publishAllowed',allowed);
END;
$$;

REVOKE ALL ON FUNCTION private.guard_social_publish_facts(),private.guard_instagram_pending_asset(),
  private.instagram_publish_allowed(UUID,UUID,UUID),private.instagram_publish_context(UUID,UUID)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_instagram_publish(UUID,UUID,UUID,UUID,TIMESTAMPTZ,UUID),
  public.get_instagram_publish(UUID,UUID,UUID),public.advance_instagram_publish(UUID,UUID,UUID,TEXT,TEXT)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_instagram_publish(UUID,UUID,UUID,UUID,TIMESTAMPTZ,UUID), public.get_instagram_publish(UUID,UUID,UUID), public.advance_instagram_publish(UUID,UUID,UUID,TEXT,TEXT) FROM service_role;

-- A legacy success has no completion callback. Protect mixed-version usage
-- whenever the old API is allowed, while retaining legacy-only refunds.
CREATE OR REPLACE FUNCTION public.reserve_content_day(p_pod_id UUID, p_generation_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET TimeZone = 'UTC'
AS $$
DECLARE
  caller_id UUID := (SELECT auth.uid());
  subscription public.subscriptions%ROWTYPE;
  anchor_date DATE;
  month_start DATE;
  next_month_start DATE;
  allowance_start DATE;
  allowance_end DATE;
  anchor_day INTEGER;
  month_last_day INTEGER;
  next_month_last_day INTEGER;
  day_limit INTEGER;
  usage public.generation_usage%ROWTYPE;
BEGIN
  IF caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = caller_id
  ) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_pod_id::TEXT,93));
  SELECT * INTO subscription FROM public.subscriptions item
  WHERE item.user_id = caller_id
    AND item.status IN ('active', 'trialing')
    AND item.current_period_end > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Active subscription required'; END IF;

  day_limit := CASE subscription.tier
    WHEN 'starter' THEN 10 WHEN 'growth' THEN 20 WHEN 'pro' THEN 30 WHEN 'scale' THEN 30 ELSE 0
  END;
  anchor_date := COALESCE(subscription.subscription_started_at, subscription.current_period_start, subscription.created_at)::date;
  anchor_day := extract(day from anchor_date)::integer;
  month_start := date_trunc('month', timezone('UTC', now()))::date;
  month_last_day := extract(day from (month_start + interval '1 month - 1 day'))::integer;
  allowance_start := month_start + (least(anchor_day, month_last_day) - 1);
  IF timezone('UTC', now())::date < allowance_start THEN
    month_start := (month_start - interval '1 month')::date;
    month_last_day := extract(day from (month_start + interval '1 month - 1 day'))::integer;
    allowance_start := month_start + (least(anchor_day, month_last_day) - 1);
  END IF;
  next_month_start := (month_start + interval '1 month')::date;
  next_month_last_day := extract(day from (next_month_start + interval '1 month - 1 day'))::integer;
  allowance_end := next_month_start + (least(anchor_day, next_month_last_day) - 1);

  IF p_generation_date < allowance_start OR p_generation_date >= allowance_end THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'outside_allowance_period', 'startsOn', allowance_start, 'endsOn', allowance_end);
  END IF;

  INSERT INTO public.generation_usage (
    user_id, pod_id, allowance_starts_at, allowance_ends_at, content_days_generated, generated_dates
  ) VALUES (
    caller_id, p_pod_id, allowance_start::timestamptz, allowance_end::timestamptz, 0, '{}'
  ) ON CONFLICT (pod_id, allowance_starts_at) DO NOTHING;

  SELECT * INTO usage FROM public.generation_usage item
  WHERE item.pod_id = p_pod_id AND item.allowance_starts_at = allowance_start::timestamptz
  FOR UPDATE;

  IF p_generation_date = ANY(usage.generated_dates) THEN
    UPDATE private.content_generation_days SET protected=TRUE WHERE usage_id=usage.id AND generation_date=p_generation_date;
    RETURN jsonb_build_object('allowed', true, 'used', usage.content_days_generated, 'limit', day_limit, 'alreadyReserved', true);
  END IF;
  IF usage.content_days_generated >= day_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'monthly_content_days_reached', 'used', usage.content_days_generated, 'limit', day_limit);
  END IF;

  UPDATE public.generation_usage SET
    generated_dates = array_append(generated_dates, p_generation_date),
    content_days_generated = content_days_generated + 1,
    updated_at = now()
  WHERE id = usage.id;
  UPDATE private.content_generation_days SET protected=TRUE WHERE usage_id=usage.id AND generation_date=p_generation_date;
  RETURN jsonb_build_object('allowed', true, 'used', usage.content_days_generated + 1, 'limit', day_limit, 'alreadyReserved', false);
END;
$$;

-- Compatibility bridge for the still-deployed API. A legacy date-only refund
-- must never erase a day protected by a new server attempt. Take the same pod
-- advisory lock and usage-row lock before inspecting the newer provenance.
CREATE OR REPLACE FUNCTION public.release_content_day(p_pod_id UUID, p_generation_date DATE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller UUID := (SELECT auth.uid());
  usage public.generation_usage%ROWTYPE;
BEGIN
  IF caller IS NULL OR NOT EXISTS (SELECT 1 FROM public.pods WHERE id=p_pod_id AND user_id=caller) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_pod_id::TEXT,93));
  FOR usage IN SELECT * FROM public.generation_usage WHERE pod_id=p_pod_id AND user_id=caller
    AND p_generation_date=ANY(generated_dates) FOR UPDATE
  LOOP
    IF EXISTS (SELECT 1 FROM private.content_generation_days d WHERE d.usage_id=usage.id
      AND d.generation_date=p_generation_date AND (d.protected OR EXISTS (
        SELECT 1 FROM private.content_generation_attempts a WHERE a.usage_id=d.usage_id
          AND a.generation_date=d.generation_date AND a.state IN ('pending','succeeded')
      ))) THEN CONTINUE; END IF;
    UPDATE public.generation_usage SET generated_dates=array_remove(generated_dates,p_generation_date),
      content_days_generated=greatest(0,content_days_generated-1),updated_at=now() WHERE id=usage.id;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.release_content_day(UUID,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.release_content_day(UUID,DATE) TO authenticated,service_role;

COMMIT;


