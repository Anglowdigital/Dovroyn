-- Dovroyn pod workspace expansion
-- Review and run after supabase-migration.sql. This file is not executed automatically.

-- Billing data mirrors Stripe. Only a trusted server/webhook should write it.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS billing_interval TEXT CHECK (billing_interval IN ('month', 'year')),
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS weekly_posting_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active', 'trialing', 'inactive', 'cancelled', 'past_due', 'unpaid', 'paused'));

-- Harden the original tables: authenticated role only, with ownership checked on both
-- sides of every update. Subscription writes remain server/webhook-only.
DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription" ON public.subscriptions FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own pods" ON public.pods;
DROP POLICY IF EXISTS "Users can create pods" ON public.pods;
DROP POLICY IF EXISTS "Users can update own pods" ON public.pods;
DROP POLICY IF EXISTS "Users can delete own pods" ON public.pods;
CREATE POLICY "Users can view own pods" ON public.pods FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can create pods" ON public.pods FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own pods" ON public.pods FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete own pods" ON public.pods FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pod_sources', 'pod_analysis', 'calendar_items', 'budgets', 'ad_analysis']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_select_base_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_select_base_' || table_name, table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_insert_base_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_insert_base_' || table_name, table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_update_base_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid()))) WITH CHECK (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_update_base_' || table_name, table_name, table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_delete_base_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_delete_base_' || table_name, table_name, table_name
    );
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Users can view own pod sources" ON public.pod_sources;
DROP POLICY IF EXISTS "Users can create pod sources" ON public.pod_sources;
DROP POLICY IF EXISTS "Users can update own pod sources" ON public.pod_sources;
DROP POLICY IF EXISTS "Users can delete own pod sources" ON public.pod_sources;
DROP POLICY IF EXISTS "Users can view own pod analysis" ON public.pod_analysis;
DROP POLICY IF EXISTS "Users can create pod analysis" ON public.pod_analysis;
DROP POLICY IF EXISTS "Users can update own pod analysis" ON public.pod_analysis;
DROP POLICY IF EXISTS "Users can view own calendar items" ON public.calendar_items;
DROP POLICY IF EXISTS "Users can create calendar items" ON public.calendar_items;
DROP POLICY IF EXISTS "Users can update own calendar items" ON public.calendar_items;
DROP POLICY IF EXISTS "Users can delete own calendar items" ON public.calendar_items;
DROP POLICY IF EXISTS "Users can view own budgets" ON public.budgets;
DROP POLICY IF EXISTS "Users can create budgets" ON public.budgets;
DROP POLICY IF EXISTS "Users can update own budgets" ON public.budgets;
DROP POLICY IF EXISTS "Users can view own ad analysis" ON public.ad_analysis;
DROP POLICY IF EXISTS "Users can create ad analysis" ON public.ad_analysis;
DROP POLICY IF EXISTS "Users can update own ad analysis" ON public.ad_analysis;

DROP POLICY IF EXISTS "Users can view own settings" ON public.user_settings;
DROP POLICY IF EXISTS "Users can create own settings" ON public.user_settings;
DROP POLICY IF EXISTS "Users can update own settings" ON public.user_settings;
CREATE POLICY "Users can view own settings" ON public.user_settings FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can create own settings" ON public.user_settings FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own settings" ON public.user_settings FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE TABLE IF NOT EXISTS public.generation_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  allowance_starts_at TIMESTAMPTZ NOT NULL,
  allowance_ends_at TIMESTAMPTZ NOT NULL,
  content_days_generated INTEGER NOT NULL DEFAULT 0 CHECK (content_days_generated >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pod_id, allowance_starts_at)
);

ALTER TABLE public.generation_usage
  ADD COLUMN IF NOT EXISTS generated_dates DATE[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.pod_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_size BIGINT CHECK (file_size IS NULL OR file_size >= 0),
  alt_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pod_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  preference_type TEXT NOT NULL,
  preference_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'user_override' CHECK (source IN ('user_override', 'approved_analysis', 'observed_result')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One shared AI service uses this table as isolated memory for each pod.
-- The model itself is not a cross-customer memory store.
CREATE TABLE IF NOT EXISTS public.pod_ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- This table exposes connection status only. OAuth tokens never belong here.
CREATE TABLE IF NOT EXISTS public.social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT,
  account_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'expired', 'revoked', 'error')),
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  connected_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pod_id, provider, provider_account_id)
);

-- A non-exposed schema separates encrypted provider credentials from browser-readable records.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS private.social_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL UNIQUE REFERENCES public.social_connections(id) ON DELETE CASCADE,
  encrypted_access_token BYTEA NOT NULL,
  encrypted_refresh_token BYTEA,
  encryption_key_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON private.social_credentials FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  body TEXT NOT NULL,
  media_asset_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'scheduled', 'publishing', 'published', 'failed')),
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  provider_post_id TEXT,
  generation_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  objective TEXT,
  brief JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'active', 'completed', 'archived')),
  starts_on DATE,
  ends_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pod_collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor', 'approver')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pod_id, invited_email)
);

CREATE TABLE IF NOT EXISTS public.coming_soon_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  headline TEXT NOT NULL,
  body TEXT,
  theme JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES public.coming_soon_pages(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL,
  consent_text TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, email)
);

CREATE TABLE IF NOT EXISTS public.analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  period_starts_at TIMESTAMPTZ NOT NULL,
  period_ends_at TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_preview BOOLEAN NOT NULL DEFAULT false,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.holiday_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL UNIQUE REFERENCES public.pods(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  region_code TEXT,
  include_public_holidays BOOLEAN NOT NULL DEFAULT true,
  include_religious_observances BOOLEAN NOT NULL DEFAULT false,
  selected_observances TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generation_usage_user_idx ON public.generation_usage(user_id, allowance_starts_at);
CREATE INDEX IF NOT EXISTS pod_assets_pod_idx ON public.pod_assets(pod_id);
CREATE INDEX IF NOT EXISTS pod_preferences_pod_idx ON public.pod_preferences(pod_id, active);
CREATE INDEX IF NOT EXISTS pod_ai_messages_pod_created_idx ON public.pod_ai_messages(pod_id, created_at DESC);
CREATE INDEX IF NOT EXISTS social_connections_pod_idx ON public.social_connections(pod_id);
CREATE INDEX IF NOT EXISTS social_posts_pod_status_idx ON public.social_posts(pod_id, status);
CREATE INDEX IF NOT EXISTS social_posts_schedule_idx ON public.social_posts(scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS campaigns_pod_idx ON public.campaigns(pod_id);
CREATE INDEX IF NOT EXISTS pod_collaborators_pod_idx ON public.pod_collaborators(pod_id);
CREATE INDEX IF NOT EXISTS email_captures_page_idx ON public.email_captures(page_id);
CREATE INDEX IF NOT EXISTS analytics_snapshots_pod_idx ON public.analytics_snapshots(pod_id, captured_at DESC);

ALTER TABLE public.generation_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pod_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coming_soon_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holiday_preferences ENABLE ROW LEVEL SECURITY;

-- Explicit Data API grants avoid depending on changing project defaults.
GRANT SELECT ON TABLE public.generation_usage TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.generation_usage FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.pod_assets,
  public.pod_preferences,
  public.social_connections,
  public.social_posts,
  public.campaigns,
  public.pod_collaborators,
  public.coming_soon_pages,
  public.analytics_snapshots,
  public.holiday_preferences
TO authenticated;
GRANT SELECT, INSERT ON TABLE public.pod_ai_messages TO authenticated;
GRANT SELECT, INSERT ON TABLE public.email_captures TO authenticated;
GRANT INSERT ON TABLE public.email_captures TO anon;

DROP POLICY IF EXISTS owner_select_generation_usage ON public.generation_usage;
CREATE POLICY owner_select_generation_usage ON public.generation_usage FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);

-- Browser-facing policies are restricted to authenticated users and the owning pod.
-- UPDATE policies include both USING and WITH CHECK so rows cannot be moved to another user's pod.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pod_assets', 'pod_preferences', 'pod_ai_messages', 'social_connections',
    'social_posts', 'campaigns', 'pod_collaborators', 'coming_soon_pages',
    'analytics_snapshots', 'holiday_preferences'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_select_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_select_' || table_name, table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_insert_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_insert_' || table_name, table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_update_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid()))) WITH CHECK (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_update_' || table_name, table_name, table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'owner_delete_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM public.pods p WHERE p.id = %I.pod_id AND p.user_id = (SELECT auth.uid())))',
      'owner_delete_' || table_name, table_name, table_name
    );
  END LOOP;
END $$;

-- Email captures join through their page, which joins through the owning pod.
DROP POLICY IF EXISTS owner_select_email_captures ON public.email_captures;
CREATE POLICY owner_select_email_captures ON public.email_captures FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.coming_soon_pages page
  JOIN public.pods pod ON pod.id = page.pod_id
  WHERE page.id = email_captures.page_id AND pod.user_id = (SELECT auth.uid())
));

-- Public page capture is intentionally insert-only and requires an explicit consent timestamp/text.
DROP POLICY IF EXISTS public_insert_email_captures ON public.email_captures;
CREATE POLICY public_insert_email_captures ON public.email_captures FOR INSERT TO anon, authenticated
WITH CHECK (
  consented_at IS NOT NULL
  AND length(trim(consent_text)) >= 10
  AND EXISTS (SELECT 1 FROM public.coming_soon_pages page WHERE page.id = email_captures.page_id AND page.status = 'published')
);

-- Keep the asset bucket private. Object names must begin user-id/pod-id/filename.
INSERT INTO storage.buckets (id, name, public)
VALUES ('pod-assets', 'pod-assets', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS pod_asset_owner_select ON storage.objects;
CREATE POLICY pod_asset_owner_select ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'pod-assets' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS pod_asset_owner_insert ON storage.objects;
CREATE POLICY pod_asset_owner_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'pod-assets'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  AND EXISTS (
    SELECT 1 FROM public.pods pod
    WHERE pod.id::text = (storage.foldername(name))[2]
      AND pod.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS pod_asset_owner_delete ON storage.objects;
CREATE POLICY pod_asset_owner_delete ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'pod-assets'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  AND EXISTS (
    SELECT 1 FROM public.pods pod
    WHERE pod.id::text = (storage.foldername(name))[2]
      AND pod.user_id = (SELECT auth.uid())
  )
);

-- Paid-tier enforcement lives in the database as well as the interface.
CREATE OR REPLACE FUNCTION private.enforce_pod_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  plan_limit INTEGER;
  active_count INTEGER;
BEGIN
  IF NEW.user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Pod owner must match the authenticated user';
  END IF;

  SELECT CASE subscription.tier
    WHEN 'starter' THEN 1 WHEN 'growth' THEN 3 WHEN 'pro' THEN 7 WHEN 'scale' THEN 12 ELSE 0
  END INTO plan_limit
  FROM public.subscriptions subscription
  WHERE subscription.user_id = NEW.user_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.current_period_end > now();

  IF COALESCE(plan_limit, 0) = 0 THEN
    RAISE EXCEPTION 'An active paid subscription is required to create a pod';
  END IF;

  SELECT count(*) INTO active_count FROM public.pods pod
  WHERE pod.user_id = NEW.user_id AND pod.status <> 'archived';

  IF active_count >= plan_limit THEN
    RAISE EXCEPTION 'Pod limit reached for this subscription tier';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_pod_limit_before_insert ON public.pods;
CREATE TRIGGER enforce_pod_limit_before_insert
BEFORE INSERT ON public.pods
FOR EACH ROW EXECUTE FUNCTION private.enforce_pod_limit();

CREATE OR REPLACE FUNCTION public.reserve_content_day(p_pod_id UUID, p_generation_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  user_id UUID := (SELECT auth.uid());
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
  IF user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = user_id
  ) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;

  SELECT * INTO subscription FROM public.subscriptions item
  WHERE item.user_id = user_id
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
    user_id, p_pod_id, allowance_start::timestamptz, allowance_end::timestamptz, 0, '{}'
  ) ON CONFLICT (pod_id, allowance_starts_at) DO NOTHING;

  SELECT * INTO usage FROM public.generation_usage item
  WHERE item.pod_id = p_pod_id AND item.allowance_starts_at = allowance_start::timestamptz
  FOR UPDATE;

  IF p_generation_date = ANY(usage.generated_dates) THEN
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
  RETURN jsonb_build_object('allowed', true, 'used', usage.content_days_generated + 1, 'limit', day_limit, 'alreadyReserved', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_content_day(p_pod_id UUID, p_generation_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = (SELECT auth.uid())) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;
  UPDATE public.generation_usage SET
    generated_dates = array_remove(generated_dates, p_generation_date),
    content_days_generated = greatest(0, content_days_generated - 1),
    updated_at = now()
  WHERE pod_id = p_pod_id AND p_generation_date = ANY(generated_dates);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_content_day(UUID, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_content_day(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_content_day(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_content_day(UUID, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION private.enforce_weekly_posting_days()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  owner_id UUID;
  posting_limit INTEGER;
  week_start TIMESTAMPTZ;
  week_end TIMESTAMPTZ;
  posting_days INTEGER;
BEGIN
  IF NEW.status NOT IN ('scheduled', 'publishing', 'published') OR NEW.scheduled_at IS NULL THEN RETURN NEW; END IF;
  SELECT pod.user_id INTO owner_id FROM public.pods pod WHERE pod.id = NEW.pod_id;
  SELECT CASE subscription.tier
    WHEN 'starter' THEN 2 WHEN 'growth' THEN 3 WHEN 'pro' THEN 6 WHEN 'scale' THEN 7 ELSE 0
  END INTO posting_limit FROM public.subscriptions subscription
  WHERE subscription.user_id = owner_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.current_period_end > now();
  IF COALESCE(posting_limit, 0) = 0 THEN RAISE EXCEPTION 'Active subscription required to schedule content'; END IF;

  week_start := date_trunc('week', NEW.scheduled_at);
  week_end := week_start + interval '7 days';
  SELECT count(DISTINCT timezone('UTC', post.scheduled_at)::date) INTO posting_days
  FROM public.social_posts post
  JOIN public.pods pod ON pod.id = post.pod_id
  WHERE pod.user_id = owner_id
    AND post.id <> NEW.id
    AND post.status IN ('scheduled', 'publishing', 'published')
    AND post.scheduled_at >= week_start AND post.scheduled_at < week_end;

  IF NOT EXISTS (
    SELECT 1 FROM public.social_posts post
    JOIN public.pods pod ON pod.id = post.pod_id
    WHERE pod.user_id = owner_id
      AND post.id <> NEW.id
      AND post.status IN ('scheduled', 'publishing', 'published')
      AND timezone('UTC', post.scheduled_at)::date = timezone('UTC', NEW.scheduled_at)::date
  ) AND posting_days >= posting_limit THEN
    RAISE EXCEPTION 'Weekly posting-day limit reached for this subscription tier';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_weekly_posting_days_before_write ON public.social_posts;
CREATE TRIGGER enforce_weekly_posting_days_before_write
BEFORE INSERT OR UPDATE OF status, scheduled_at ON public.social_posts
FOR EACH ROW EXECUTE FUNCTION private.enforce_weekly_posting_days();


