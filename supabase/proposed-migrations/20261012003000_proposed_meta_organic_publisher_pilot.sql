-- PROPOSED ONLY. Do not apply automatically.
-- Meta organic publisher pilot foundation for Facebook Pages + Instagram.
-- No scheduler, live provider access, production grants, or deployment is
-- introduced by this proposal.

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.meta_organic_publisher_uuid()
RETURNS UUID
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT (
    substr(md5(clock_timestamp()::text || random()::text), 1, 8) || '-' ||
    substr(md5(clock_timestamp()::text || random()::text), 1, 4) || '-' ||
    '4' || substr(md5(clock_timestamp()::text || random()::text), 1, 3) || '-' ||
    '8' || substr(md5(clock_timestamp()::text || random()::text), 1, 3) || '-' ||
    substr(md5(clock_timestamp()::text || random()::text), 1, 12)
  )::uuid;
$$;

CREATE TABLE IF NOT EXISTS private.meta_organic_publish_jobs (
  id UUID PRIMARY KEY DEFAULT private.meta_organic_publisher_uuid(),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE RESTRICT,
  draft_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('facebook','instagram')),
  account_connection_id UUID NOT NULL,
  content_version TEXT NOT NULL,
  asset_manifest_hash TEXT NOT NULL,
  approval_id UUID NOT NULL,
  campaign_date DATE NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','retry','published','failed','blocked','unknown','reconciling')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  lease_expires_at TIMESTAMPTZ,
  leased_by TEXT,
  operation_token TEXT CHECK (operation_token IS NULL OR operation_token ~ '^[a-f0-9]{48,128}$'),
  scheduled_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  error_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  contract_version TEXT NOT NULL DEFAULT 'meta_organic_publisher_pilot_v1',
  provider_verified_source TEXT NOT NULL DEFAULT 'meta_organic_publisher_foundation_2026_10_12',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_organic_publish_jobs_claim_idx
  ON private.meta_organic_publish_jobs (state, retry_at, lease_expires_at, created_at)
  WHERE state IN ('queued','retry','leased');

CREATE INDEX IF NOT EXISTS meta_organic_publish_jobs_reconcile_idx
  ON private.meta_organic_publish_jobs (state, lease_expires_at, updated_at)
  WHERE state IN ('unknown','reconciling');

CREATE INDEX IF NOT EXISTS meta_organic_publish_jobs_day_idx
  ON private.meta_organic_publish_jobs (pod_id, campaign_date)
  WHERE state NOT IN ('failed','blocked');

CREATE UNIQUE INDEX IF NOT EXISTS meta_organic_publish_jobs_delivery_identity_idx
  ON private.meta_organic_publish_jobs (
    draft_id,
    account_connection_id,
    content_version,
    asset_manifest_hash,
    campaign_date
  );

-- Proposed authoritative approval/export rows. These are not populated by the
-- current renderer. Missing rows make get_meta_organic_publish_context fail
-- closed with PUBLISH_APPROVAL_CONTEXT_REQUIRED or PUBLISH_EXPORT_CONTEXT_REQUIRED.
CREATE TABLE IF NOT EXISTS private.meta_organic_publish_approvals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE RESTRICT,
  draft_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('facebook','instagram')),
  account_connection_id UUID NOT NULL,
  content_version TEXT NOT NULL,
  asset_manifest_hash TEXT NOT NULL,
  campaign_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved','revoked')),
  approved_at TIMESTAMPTZ NOT NULL,
  approved_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS private.meta_organic_publish_exports (
  manifest_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE RESTRICT,
  draft_id UUID NOT NULL,
  account_connection_id UUID NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  output_hash TEXT NOT NULL CHECK (output_hash ~ '^[a-f0-9]{64}$'),
  provider_readable_url TEXT NOT NULL CHECK (provider_readable_url ~ '^https://'),
  provider_readable_url_expires_at TIMESTAMPTZ NOT NULL,
  object_version TEXT NOT NULL,
  manifest JSONB NOT NULL,
  immutable BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (status IN ('exported','revoked')),
  exported_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS private.meta_organic_publish_receipts (
  id UUID PRIMARY KEY DEFAULT private.meta_organic_publisher_uuid(),
  job_id UUID NOT NULL REFERENCES private.meta_organic_publish_jobs(id) ON DELETE CASCADE,
  account_connection_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('facebook','instagram')),
  provider_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published','unknown','failed','reconciled')),
  provider_post_id TEXT,
  permalink TEXT,
  raw_receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE private.meta_organic_publish_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meta_organic_publish_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meta_organic_publish_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meta_organic_publish_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON private.meta_organic_publish_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.meta_organic_publish_approvals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.meta_organic_publish_exports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.meta_organic_publish_receipts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.meta_organic_job_json(job private.meta_organic_publish_jobs)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', job.id,
    'dedupeKey', job.dedupe_key,
    'userId', job.user_id,
    'podId', job.pod_id,
    'draftId', job.draft_id,
    'provider', job.provider,
    'accountConnectionId', job.account_connection_id,
    'contentVersion', job.content_version,
    'assetManifestHash', job.asset_manifest_hash,
    'approvalId', job.approval_id,
    'campaignDate', job.campaign_date,
    'state', job.state,
    'attempts', job.attempts,
    'leasedBy', job.leased_by,
    'operationToken', job.operation_token,
    'leaseExpiresAt', job.lease_expires_at,
    'scheduledAt', job.scheduled_at,
    'retryAt', job.retry_at,
    'errorCode', job.error_code,
    'contractVersion', job.contract_version,
    'providerVerifiedSource', job.provider_verified_source
  );
$$;

CREATE OR REPLACE FUNCTION private.meta_organic_require_lease(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_allow_expired BOOLEAN DEFAULT false
)
RETURNS private.meta_organic_publish_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job
  FROM private.meta_organic_publish_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUBLISH_JOB_NOT_FOUND';
  END IF;
  IF job.state <> 'leased'
    OR job.leased_by IS DISTINCT FROM p_worker_id
    OR job.operation_token IS DISTINCT FROM p_operation_token
    OR (NOT p_allow_expired AND job.lease_expires_at <= now()) THEN
    RAISE EXCEPTION 'PUBLISH_LEASE_REQUIRED';
  END IF;
  RETURN job;
END;
$$;

CREATE OR REPLACE FUNCTION private.meta_organic_require_reconciliation_claim(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT
)
RETURNS private.meta_organic_publish_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job
  FROM private.meta_organic_publish_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUBLISH_JOB_NOT_FOUND';
  END IF;
  IF job.state <> 'reconciling'
    OR job.leased_by IS DISTINCT FROM p_worker_id
    OR job.operation_token IS DISTINCT FROM p_operation_token
    OR job.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'PUBLISH_RECONCILIATION_CLAIM_REQUIRED';
  END IF;
  RETURN job;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_meta_organic_publish_job(p_proposal JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.meta_organic_publish_jobs%ROWTYPE;
  pod public.pods%ROWTYPE;
  subscription public.subscriptions%ROWTYPE;
  inserted BOOLEAN := false;
  p_user_id UUID := (p_proposal->>'userId')::uuid;
  p_pod_id UUID := (p_proposal->>'podId')::uuid;
  p_dedupe_key TEXT := p_proposal->>'dedupeKey';
  p_campaign_date DATE := (p_proposal->>'campaignDate')::date;
  day_limit INTEGER;
  week_limit INTEGER;
  anchor_date DATE;
  month_start DATE;
  next_month_start DATE;
  allowance_start DATE;
  allowance_end DATE;
  anchor_day INTEGER;
  week_start DATE;
  week_end DATE;
  existing_month_dates INTEGER;
  existing_week_dates INTEGER;
  date_already_reserved BOOLEAN;
  owner_week_date_already_reserved BOOLEAN;
  export_row private.meta_organic_publish_exports%ROWTYPE;
  latest_creative_review public.pod_preferences%ROWTYPE;
BEGIN
  IF p_proposal->>'contractVersion' IS DISTINCT FROM 'meta_organic_publisher_pilot_v1' THEN
    RAISE EXCEPTION 'PUBLISH_CONTRACT_VERSION_REQUIRED';
  END IF;
  SELECT * INTO pod FROM public.pods p WHERE p.id = p_pod_id AND p.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PUBLISH_TENANT_MISMATCH';
  END IF;

  SELECT * INTO subscription FROM public.subscriptions item
  WHERE item.user_id = p_user_id
    AND item.status IN ('active','trialing')
    AND item.current_period_end > now()
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_PAID_PLAN_REQUIRED'; END IF;
  day_limit := CASE subscription.tier WHEN 'starter' THEN 10 WHEN 'growth' THEN 20 WHEN 'pro' THEN 30 WHEN 'scale' THEN 30 ELSE 0 END;
  week_limit := CASE subscription.tier WHEN 'starter' THEN 2 WHEN 'growth' THEN 3 WHEN 'pro' THEN 6 WHEN 'scale' THEN 7 ELSE 0 END;
  IF day_limit = 0 OR week_limit = 0 THEN RAISE EXCEPTION 'PUBLISH_PAID_PLAN_REQUIRED'; END IF;

  anchor_date := coalesce(subscription.subscription_started_at, subscription.current_period_start, subscription.created_at)::date;
  anchor_day := extract(day FROM anchor_date)::integer;
  month_start := date_trunc('month', p_campaign_date)::date;
  allowance_start := month_start + (least(anchor_day, extract(day FROM (month_start + interval '1 month - 1 day'))::integer) - 1);
  IF p_campaign_date < allowance_start THEN
    month_start := (month_start - interval '1 month')::date;
    allowance_start := month_start + (least(anchor_day, extract(day FROM (month_start + interval '1 month - 1 day'))::integer) - 1);
  END IF;
  next_month_start := (month_start + interval '1 month')::date;
  allowance_end := next_month_start + (least(anchor_day, extract(day FROM (next_month_start + interval '1 month - 1 day'))::integer) - 1);
  week_start := date_trunc('week', p_campaign_date::timestamp)::date;
  week_end := week_start + 7;

  SELECT EXISTS (
    SELECT 1 FROM private.meta_organic_publish_jobs existing
    WHERE existing.pod_id = p_pod_id
      AND existing.campaign_date = p_campaign_date
      AND existing.state NOT IN ('failed','blocked')
  ) INTO date_already_reserved;

  SELECT EXISTS (
    SELECT 1
    FROM private.meta_organic_publish_jobs existing
    JOIN public.pods existing_pod ON existing_pod.id = existing.pod_id
    WHERE existing_pod.user_id = p_user_id
      AND existing.campaign_date = p_campaign_date
      AND existing.state NOT IN ('failed','blocked')
  ) INTO owner_week_date_already_reserved;

  SELECT count(DISTINCT existing.campaign_date) INTO existing_month_dates
  FROM private.meta_organic_publish_jobs existing
  WHERE existing.pod_id = p_pod_id
    AND existing.state NOT IN ('failed','blocked')
    AND existing.campaign_date >= allowance_start
    AND existing.campaign_date < allowance_end;

  SELECT count(DISTINCT existing.campaign_date) INTO existing_week_dates
  FROM private.meta_organic_publish_jobs existing
  JOIN public.pods existing_pod ON existing_pod.id = existing.pod_id
  WHERE existing_pod.user_id = p_user_id
    AND existing.state NOT IN ('failed','blocked')
    AND existing.campaign_date >= week_start
    AND existing.campaign_date < week_end;

  IF NOT date_already_reserved AND existing_month_dates >= day_limit THEN
    RAISE EXCEPTION 'PUBLISH_DISTINCT_DAY_LIMIT';
  END IF;
  IF NOT owner_week_date_already_reserved AND existing_week_dates >= week_limit THEN
    RAISE EXCEPTION 'PUBLISH_WEEKLY_DISTINCT_DAY_LIMIT';
  END IF;

  SELECT * INTO export_row
  FROM private.meta_organic_publish_exports
  WHERE manifest_hash = p_proposal->>'assetManifestHash'
    AND user_id = p_user_id
    AND pod_id = p_pod_id
    AND draft_id = (p_proposal->>'draftId')::uuid
    AND account_connection_id = (p_proposal->>'accountConnectionId')::uuid
    AND status = 'exported'
    AND immutable;
  IF FOUND THEN
    SELECT * INTO latest_creative_review
    FROM public.pod_preferences
    WHERE pod_id = p_pod_id
      AND preference_type = 'creative_review'
      AND active IS TRUE
      AND preference_value->>'post_id' = p_proposal->>'draftId'
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
    IF NOT FOUND OR latest_creative_review.id::text IS DISTINCT FROM export_row.manifest->'authority'->>'creativeApprovalId'
      OR latest_creative_review.preference_value->>'status' IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'PUBLISH_EXPORT_SUPERSEDED';
    END IF;
  END IF;

  INSERT INTO private.meta_organic_publish_jobs (
    dedupe_key, user_id, pod_id, draft_id, provider, account_connection_id,
    content_version, asset_manifest_hash, approval_id, campaign_date, scheduled_at
  )
  VALUES (
    p_dedupe_key,
    p_user_id,
    p_pod_id,
    (p_proposal->>'draftId')::uuid,
    p_proposal->>'provider',
    (p_proposal->>'accountConnectionId')::uuid,
    p_proposal->>'contentVersion',
    p_proposal->>'assetManifestHash',
    (p_proposal->>'approvalId')::uuid,
    p_campaign_date,
    NULLIF(p_proposal->>'scheduledAt', '')::timestamptz
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO job;

  IF FOUND THEN
    inserted := true;
  ELSE
    SELECT * INTO job
    FROM private.meta_organic_publish_jobs
    WHERE draft_id = (p_proposal->>'draftId')::uuid
      AND account_connection_id = (p_proposal->>'accountConnectionId')::uuid
      AND content_version = p_proposal->>'contentVersion'
      AND asset_manifest_hash = p_proposal->>'assetManifestHash'
      AND campaign_date = p_campaign_date;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PUBLISH_DEDUPE_CONFLICT';
    END IF;
  END IF;

  RETURN private.meta_organic_job_json(job) || jsonb_build_object('duplicate', NOT inserted);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_meta_organic_publish_job(
  p_worker_id TEXT,
  p_now TIMESTAMPTZ,
  p_lease_ms INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_id UUID;
  job private.meta_organic_publish_jobs%ROWTYPE;
  expired private.meta_organic_publish_jobs%ROWTYPE;
  expired_account_id TEXT;
BEGIN
  IF btrim(coalesce(p_worker_id, '')) = '' OR p_lease_ms < 30000 OR p_lease_ms > 900000 THEN
    RAISE EXCEPTION 'PUBLISH_CLAIM_INVALID';
  END IF;

  SELECT * INTO expired
  FROM private.meta_organic_publish_jobs
  WHERE state = 'leased'
    AND lease_expires_at <= p_now
  ORDER BY lease_expires_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF FOUND THEN
    SELECT provider_account_id INTO expired_account_id
    FROM private.meta_organic_connections
    WHERE id = expired.account_connection_id;

    UPDATE private.meta_organic_publish_jobs
    SET state = 'unknown',
        error_code = 'PUBLISH_LEASE_EXPIRED_RECONCILE_REQUIRED',
        details = jsonb_build_object(
          'provider', expired.provider,
          'providerAccountId', expired_account_id,
          'reason', 'PUBLISH_LEASE_EXPIRED_RECONCILE_REQUIRED'
        ),
        leased_by = NULL,
        operation_token = NULL,
        lease_expires_at = NULL,
        updated_at = p_now
    WHERE id = expired.id
    RETURNING * INTO expired;

    INSERT INTO private.meta_organic_publish_receipts (
      job_id, account_connection_id, provider, provider_account_id, status, raw_receipt
    )
    VALUES (
      expired.id, expired.account_connection_id, expired.provider, coalesce(expired_account_id, 'unknown'),
      'unknown', jsonb_build_object(
        'provider', expired.provider,
        'providerAccountId', expired_account_id,
        'reason', 'PUBLISH_LEASE_EXPIRED_RECONCILE_REQUIRED'
      )
    );

    RETURN NULL;
  END IF;

  SELECT id INTO job_id
  FROM private.meta_organic_publish_jobs
  WHERE state IN ('queued','retry')
    AND (retry_at IS NULL OR retry_at <= p_now)
    AND (scheduled_at IS NULL OR scheduled_at <= p_now)
  ORDER BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF job_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE private.meta_organic_publish_jobs
  SET state = 'leased',
      leased_by = p_worker_id,
      operation_token = md5(private.meta_organic_publisher_uuid()::text || p_worker_id || p_now::text)
        || md5(p_worker_id || p_now::text || private.meta_organic_publisher_uuid()::text),
      lease_expires_at = p_now + (p_lease_ms || ' milliseconds')::interval,
      updated_at = p_now
  WHERE id = job_id
  RETURNING * INTO job;

  RETURN private.meta_organic_job_json(job);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_meta_organic_publish_context(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job private.meta_organic_publish_jobs%ROWTYPE;
  pod public.pods%ROWTYPE;
  subscription public.subscriptions%ROWTYPE;
  draft public.social_posts%ROWTYPE;
  approval private.meta_organic_publish_approvals%ROWTYPE;
  export_row private.meta_organic_publish_exports%ROWTYPE;
  latest_creative_review public.pod_preferences%ROWTYPE;
  connection private.meta_organic_connections%ROWTYPE;
  credential private.meta_organic_credentials%ROWTYPE;
  required_scopes TEXT[];
  existing_dates JSONB;
  anchor_date DATE;
  month_start DATE;
  next_month_start DATE;
  allowance_start DATE;
  allowance_end DATE;
  anchor_day INTEGER;
BEGIN
  job := private.meta_organic_require_lease(p_job_id, p_worker_id, p_operation_token, false);

  SELECT * INTO pod FROM public.pods WHERE id = job.pod_id AND user_id = job.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_TENANT_MISMATCH'; END IF;
  IF btrim(coalesce(pod.accepted_strategy, '')) = '' THEN
    RAISE EXCEPTION 'PUBLISH_DIRECTION_REQUIRED';
  END IF;

  SELECT * INTO draft FROM public.social_posts
  WHERE id = job.draft_id
    AND pod_id = job.pod_id
    AND platform = job.provider
    AND status IN ('approved','scheduled');
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_CONTEXT_REQUIRED'; END IF;
  IF md5(draft.body) IS DISTINCT FROM job.content_version THEN
    RAISE EXCEPTION 'PUBLISH_CONTENT_CHANGED';
  END IF;

  SELECT * INTO subscription FROM public.subscriptions WHERE user_id = job.user_id;
  IF NOT FOUND OR subscription.status NOT IN ('active','trialing') OR subscription.current_period_end <= now() THEN
    RAISE EXCEPTION 'PUBLISH_PAID_PLAN_REQUIRED';
  END IF;

  SELECT * INTO approval FROM private.meta_organic_publish_approvals
  WHERE id = job.approval_id
    AND user_id = job.user_id
    AND pod_id = job.pod_id
    AND draft_id = job.draft_id
    AND provider = job.provider
    AND account_connection_id = job.account_connection_id
    AND content_version = job.content_version
    AND asset_manifest_hash = job.asset_manifest_hash
    AND campaign_date = job.campaign_date
    AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_APPROVAL_CONTEXT_REQUIRED'; END IF;

  SELECT * INTO export_row FROM private.meta_organic_publish_exports
  WHERE manifest_hash = job.asset_manifest_hash
    AND user_id = job.user_id
    AND pod_id = job.pod_id
    AND draft_id = job.draft_id
    AND account_connection_id = job.account_connection_id
    AND media_type = 'image/jpeg'
    AND provider_readable_url_expires_at > now() + interval '10 minutes'
    AND manifest->'authority'->>'userId' = job.user_id::text
    AND manifest->'authority'->>'podId' = job.pod_id::text
    AND manifest->'authority'->>'postId' = job.draft_id::text
    AND manifest->'authority'->>'accountConnectionId' = job.account_connection_id::text
    AND btrim(coalesce(manifest->'authority'->>'creativeApprovalId', '')) <> ''
    AND manifest->'authority'->>'provider' = job.provider
    AND manifest->'authority'->>'contentVersion' = job.content_version
    AND manifest->>'manifestHash' = manifest_hash
    AND manifest->'authority'->>'rendererVersion' = 'sharp_svg_jpeg_2026_10_12_v1'
    AND manifest->'composition'->>'version' = 'meta_organic_creative_composition_v2'
    AND manifest->'composition'->>'layout' = 'meta-organic-portrait-v1'
    AND manifest->'composition'->>'fontContract' = 'system-ui-safe-v1'
    AND manifest->'output'->>'hash' = output_hash
    AND manifest->'output'->>'mediaType' = 'image/jpeg'
    AND manifest->'output'->>'providerReadableUrl' = provider_readable_url
    AND manifest->'output'->>'objectPath' = object_version
    AND immutable
    AND status = 'exported';
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_EXPORT_CONTEXT_REQUIRED'; END IF;

  SELECT * INTO latest_creative_review
  FROM public.pod_preferences
  WHERE pod_id = job.pod_id
    AND preference_type = 'creative_review'
    AND active IS TRUE
    AND preference_value->>'post_id' = job.draft_id::text
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF NOT FOUND OR latest_creative_review.id::text IS DISTINCT FROM export_row.manifest->'authority'->>'creativeApprovalId'
    OR latest_creative_review.preference_value->>'status' IS DISTINCT FROM 'approved'
    OR latest_creative_review.preference_value->>'content_snapshot' IS DISTINCT FROM draft.body THEN
    RAISE EXCEPTION 'PUBLISH_EXPORT_SUPERSEDED';
  END IF;

  SELECT * INTO connection FROM private.meta_organic_connections
  WHERE id = job.account_connection_id
    AND user_id = job.user_id
    AND pod_id = job.pod_id
    AND provider = job.provider
    AND status = 'connected'
    AND expires_at > now() + interval '1 minute';
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_CONTEXT_REQUIRED'; END IF;

  SELECT * INTO credential FROM private.meta_organic_credentials
  WHERE connection_id = connection.id
    AND token_kind = 'page'
    AND encrypted_access_token IS NOT NULL
    AND encryption_key_version IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_CREDENTIAL_CONTEXT_REQUIRED'; END IF;

  required_scopes := CASE job.provider
    WHEN 'facebook' THEN ARRAY['pages_manage_posts','pages_read_engagement']
    ELSE ARRAY['instagram_basic','instagram_content_publish','pages_read_engagement']
  END;
  IF NOT connection.granted_scopes @> required_scopes THEN
    RAISE EXCEPTION 'PUBLISH_PERMISSION_REQUIRED';
  END IF;

  anchor_date := coalesce(subscription.subscription_started_at, subscription.current_period_start, subscription.created_at)::date;
  anchor_day := extract(day FROM anchor_date)::integer;
  month_start := date_trunc('month', job.campaign_date)::date;
  allowance_start := month_start + (least(anchor_day, extract(day FROM (month_start + interval '1 month - 1 day'))::integer) - 1);
  IF job.campaign_date < allowance_start THEN
    month_start := (month_start - interval '1 month')::date;
    allowance_start := month_start + (least(anchor_day, extract(day FROM (month_start + interval '1 month - 1 day'))::integer) - 1);
  END IF;
  next_month_start := (month_start + interval '1 month')::date;
  allowance_end := next_month_start + (least(anchor_day, extract(day FROM (next_month_start + interval '1 month - 1 day'))::integer) - 1);

  SELECT coalesce(jsonb_agg(DISTINCT campaign_date), '[]'::jsonb) INTO existing_dates
  FROM private.meta_organic_publish_jobs
  WHERE pod_id = job.pod_id
    AND state NOT IN ('failed','blocked')
    AND campaign_date >= allowance_start
    AND campaign_date < allowance_end;

  RETURN jsonb_build_object(
    'proposal', private.meta_organic_job_json(job),
    'job', private.meta_organic_job_json(job),
    'pod', jsonb_build_object('id', pod.id, 'userId', pod.user_id, 'acceptedStrategy', pod.accepted_strategy),
    'subscription', jsonb_build_object('tier', subscription.tier, 'status', subscription.status, 'current_period_end', subscription.current_period_end),
    'draft', jsonb_build_object(
      'id', draft.id,
      'userId', job.user_id,
      'podId', draft.pod_id,
      'provider', draft.platform,
      'status', 'approved',
      'caption', draft.body,
      'contentVersion', md5(draft.body),
      'acceptedStrategy', pod.accepted_strategy
    ),
    'approval', jsonb_build_object(
      'id', approval.id,
      'userId', approval.user_id,
      'podId', approval.pod_id,
      'draftId', approval.draft_id,
      'accountConnectionId', approval.account_connection_id,
      'contentVersion', approval.content_version,
      'assetManifestHash', approval.asset_manifest_hash,
      'campaignDate', approval.campaign_date,
      'approvedAt', approval.approved_at,
      'status', approval.status
    ),
    'asset', jsonb_build_object(
      'userId', export_row.user_id,
      'podId', export_row.pod_id,
      'draftId', export_row.draft_id,
      'accountConnectionId', export_row.account_connection_id,
      'manifestHash', export_row.manifest_hash,
      'providerReadableUrl', export_row.provider_readable_url,
      'providerReadableUrlExpiresAt', export_row.provider_readable_url_expires_at,
      'outputHash', export_row.output_hash,
      'objectVersion', export_row.object_version,
      'status', export_row.status,
      'immutable', export_row.immutable,
      'mediaType', export_row.media_type,
      'manifest', export_row.manifest
    ),
    'account', jsonb_build_object(
      'id', connection.id,
      'userId', connection.user_id,
      'podId', connection.pod_id,
      'provider', connection.provider,
      'providerAccountId', connection.provider_account_id,
      'status', connection.status,
      'expiresAt', connection.expires_at,
      'tokenKind', credential.token_kind,
      'grantedScopes', connection.granted_scopes
    ),
    'existingCampaignDates', existing_dates
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_meta_organic_artwork_export_context(p_request JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pod public.pods%ROWTYPE;
  draft public.social_posts%ROWTYPE;
  approval public.pod_preferences%ROWTYPE;
  latest_approval public.pod_preferences%ROWTYPE;
  connection private.meta_organic_connections%ROWTYPE;
  assets JSONB;
  source_media JSONB;
BEGIN
  IF p_request->>'contractVersion' IS DISTINCT FROM 'meta_organic_artwork_export_v1' THEN
    RAISE EXCEPTION 'EXPORT_CONTRACT_VERSION_REQUIRED';
  END IF;

  SELECT * INTO pod
  FROM public.pods
  WHERE id = (p_request->>'podId')::uuid
    AND user_id = (p_request->>'userId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPORT_TENANT_MISMATCH'; END IF;

  SELECT * INTO draft
  FROM public.social_posts
  WHERE id = (p_request->>'postId')::uuid
    AND pod_id = pod.id
    AND platform = p_request->>'provider'
    AND status IN ('approved','scheduled');
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPORT_POST_CONTEXT_REQUIRED'; END IF;

  SELECT * INTO approval
  FROM public.pod_preferences
  WHERE id = (p_request->>'creativeApprovalId')::uuid
    AND pod_id = pod.id
    AND preference_type = 'creative_review'
    AND active IS TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPORT_APPROVAL_CONTEXT_REQUIRED'; END IF;

  SELECT * INTO latest_approval
  FROM public.pod_preferences
  WHERE pod_id = pod.id
    AND preference_type = 'creative_review'
    AND active IS TRUE
    AND preference_value->>'post_id' = draft.id::text
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF NOT FOUND OR latest_approval.id IS DISTINCT FROM approval.id THEN
    RAISE EXCEPTION 'EXPORT_APPROVAL_SUPERSEDED';
  END IF;
  IF approval.preference_value->>'content_snapshot' IS DISTINCT FROM draft.body THEN
    RAISE EXCEPTION 'EXPORT_APPROVAL_STALE';
  END IF;

  SELECT * INTO connection
  FROM private.meta_organic_connections
  WHERE user_id = pod.user_id
    AND pod_id = pod.id
    AND provider = p_request->>'provider'
    AND provider_account_id = p_request->>'providerAccountId'
    AND status = 'connected'
    AND (
      nullif(p_request->>'accountConnectionId', '') IS NULL
      OR id = (p_request->>'accountConnectionId')::uuid
    );
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPORT_ACCOUNT_CONTEXT_REQUIRED'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', asset.id,
    'pod_id', asset.pod_id,
    'storagePath', asset.storage_path,
    'name', asset.file_name,
    'type', asset.media_type,
    'media_type', asset.media_type,
    'file_size', asset.file_size,
    'assetRole', asset.asset_role
  )), '[]'::jsonb) INTO assets
  FROM public.pod_assets asset
  WHERE asset.pod_id = pod.id;

  SELECT coalesce(pref.preference_value->'source_media', '[]'::jsonb) INTO source_media
  FROM public.pod_preferences pref
  WHERE pref.pod_id = pod.id
    AND pref.preference_type = 'website_intelligence'
    AND pref.active IS TRUE
    AND jsonb_typeof(pref.preference_value->'source_media') = 'array'
  ORDER BY pref.created_at DESC, pref.id DESC
  LIMIT 1;
  source_media := coalesce(source_media, '[]'::jsonb);

  RETURN jsonb_build_object(
    'pod', jsonb_build_object('id', pod.id, 'userId', pod.user_id),
    'post', jsonb_build_object(
      'id', draft.id,
      'userId', pod.user_id,
      'podId', draft.pod_id,
      'platform', draft.platform,
      'status', draft.status,
      'body', draft.body,
      'updated_at', draft.updated_at
    ),
    'approvalRow', jsonb_build_object(
      'id', approval.id,
      'pod_id', approval.pod_id,
      'preference_type', approval.preference_type,
      'preference_value', approval.preference_value,
      'active', approval.active,
      'created_at', approval.created_at
    ),
    'latestApprovalRow', jsonb_build_object(
      'id', latest_approval.id,
      'pod_id', latest_approval.pod_id,
      'preference_type', latest_approval.preference_type,
      'preference_value', latest_approval.preference_value,
      'active', latest_approval.active,
      'created_at', latest_approval.created_at
    ),
    'account', jsonb_build_object(
      'provider', connection.provider,
      'accountConnectionId', connection.id,
      'providerAccountId', connection.provider_account_id,
      'accountLabel', connection.account_label
    ),
    'assets', assets,
    'sourceMedia', source_media
  );
END;
$$;

-- Canonical JSON matches the exporter: sorted object keys, compact separators,
-- array order preserved. Manifest keys and numeric fields are fixed by the contract.
CREATE OR REPLACE FUNCTION private.meta_organic_canonical_json(value JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = ''
AS $$
DECLARE result TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' ||
        private.meta_organic_canonical_json(val), ',' ORDER BY key COLLATE "C"), '') || '}'
      INTO result FROM jsonb_each(value) AS entries(key, val);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(private.meta_organic_canonical_json(val), ',' ORDER BY ordinal), '') || ']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(val, ordinal);
    ELSE result := value::text;
  END CASE;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_meta_organic_artwork_export_manifest(p_manifest JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  existing private.meta_organic_publish_exports%ROWTYPE;
  inserted private.meta_organic_publish_exports%ROWTYPE;
  draft public.social_posts%ROWTYPE;
  latest_approval public.pod_preferences%ROWTYPE;
  approved JSONB;
  source_evidence JSONB;
  expected_source JSONB;
  expected_composition JSONB;
  hash_payload JSONB;
BEGIN
  IF p_manifest->>'contractVersion' IS DISTINCT FROM 'meta_organic_artwork_export_v1'
    OR p_manifest->>'status' IS DISTINCT FROM 'exported'
    OR (p_manifest->>'immutable')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'EXPORT_MANIFEST_CONTRACT_REQUIRED';
  END IF;
  IF btrim(coalesce(p_manifest->'authority'->>'creativeApprovalId', '')) = ''
    OR btrim(coalesce(p_manifest->'authority'->>'accountConnectionId', '')) = ''
    OR btrim(coalesce(p_manifest->'output'->>'hash', '')) = ''
    OR p_manifest->'output'->>'mediaType' IS DISTINCT FROM 'image/jpeg'
    OR coalesce(p_manifest->'output'->>'providerReadableUrl', '') !~ '^https://' THEN
    RAISE EXCEPTION 'EXPORT_MANIFEST_CONTRACT_REQUIRED';
  END IF;
  IF (p_manifest->'authority'->>'rendererVersion') IS DISTINCT FROM 'sharp_svg_jpeg_2026_10_12_v1'
    OR (p_manifest->'composition'->>'version') IS DISTINCT FROM 'meta_organic_creative_composition_v2'
    OR (p_manifest->'composition'->>'layout') IS DISTINCT FROM 'meta-organic-portrait-v1'
    OR (p_manifest->'composition'->>'fontContract') IS DISTINCT FROM 'system-ui-safe-v1'
    OR (p_manifest->'output'->>'objectPath') IS DISTINCT FROM (
      'meta-organic-exports/' ||
      (p_manifest->'authority'->>'userId') || '/' ||
      (p_manifest->'authority'->>'podId') || '/' ||
      (p_manifest->'authority'->>'postId') || '/' ||
      (p_manifest->'authority'->>'creativeApprovalId') || '/' ||
      (p_manifest->'authority'->>'accountConnectionId') || '/' ||
      (p_manifest->'output'->>'hash') || '.jpg'
    )
    OR (p_manifest->'output'->>'providerReadableUrlExpiresAt') IS NULL THEN
    RAISE EXCEPTION 'EXPORT_MANIFEST_CONTRACT_REQUIRED';
  END IF;

  hash_payload := jsonb_build_object(
    'contractVersion', p_manifest->'contractVersion',
    'authority', p_manifest->'authority',
    'composition', p_manifest->'composition',
    'source', jsonb_build_object(
      'kind', p_manifest->'source'->'kind',
      'identity', p_manifest->'source'->'identity',
      'sourceUrl', coalesce(p_manifest->'source'->'sourceUrl', 'null'::jsonb),
      'hash', coalesce(p_manifest->'source'->'hash', 'null'::jsonb),
      'objectVersion', coalesce(p_manifest->'source'->'objectVersion', 'null'::jsonb),
      'revision', coalesce(p_manifest->'source'->'revision', 'null'::jsonb),
      'mediaType', coalesce(p_manifest->'source'->'mediaType', 'null'::jsonb),
      'byteLength', coalesce(p_manifest->'source'->'byteLength', '0'::jsonb)),
    'output', jsonb_build_object(
      'hash', p_manifest->'output'->'hash', 'mediaType', p_manifest->'output'->'mediaType',
      'dimensions', p_manifest->'output'->'dimensions', 'byteLength', p_manifest->'output'->'byteLength',
      'objectPath', p_manifest->'output'->'objectPath',
      'providerReadableUrl', p_manifest->'output'->'providerReadableUrl',
      'providerReadableUrlExpiresAt', p_manifest->'output'->'providerReadableUrlExpiresAt'));
  IF encode(sha256(convert_to(private.meta_organic_canonical_json(hash_payload), 'UTF8')), 'hex')
      IS DISTINCT FROM p_manifest->>'manifestHash' THEN
    RAISE EXCEPTION 'EXPORT_MANIFEST_HASH_MISMATCH';
  END IF;
  PERFORM 1 FROM public.pods pod
    JOIN private.meta_organic_connections connection ON connection.pod_id = pod.id AND connection.user_id = pod.user_id
    WHERE pod.id = (p_manifest->'authority'->>'podId')::uuid
      AND pod.user_id = (p_manifest->'authority'->>'userId')::uuid
      AND connection.id = (p_manifest->'authority'->>'accountConnectionId')::uuid
      AND connection.provider = p_manifest->'authority'->>'provider'
      AND connection.provider_account_id = p_manifest->'authority'->>'providerAccountId'
      AND connection.status = 'connected';
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPORT_ACCOUNT_CONTEXT_REQUIRED'; END IF;

  SELECT * INTO draft
  FROM public.social_posts
  WHERE id = (p_manifest->'authority'->>'postId')::uuid
    AND pod_id = (p_manifest->'authority'->>'podId')::uuid
    AND platform = p_manifest->'authority'->>'provider'
    AND status IN ('approved','scheduled');
  IF NOT FOUND OR md5(draft.body) IS DISTINCT FROM p_manifest->'authority'->>'contentVersion' THEN
    RAISE EXCEPTION 'EXPORT_CONTEXT_CHANGED';
  END IF;

  SELECT * INTO latest_approval
  FROM public.pod_preferences
  WHERE id = (p_manifest->'authority'->>'creativeApprovalId')::uuid
    AND pod_id = (p_manifest->'authority'->>'podId')::uuid
    AND preference_type = 'creative_review'
    AND active IS TRUE
    AND preference_value->>'post_id' = p_manifest->'authority'->>'postId'
    AND preference_value->>'status' = 'approved'
    AND preference_value->>'content_snapshot' = draft.body;
  IF NOT FOUND THEN RAISE EXCEPTION 'EXPORT_APPROVAL_CONTEXT_REQUIRED'; END IF;

  PERFORM 1
  FROM public.pod_preferences newer
  WHERE newer.pod_id = latest_approval.pod_id
    AND newer.preference_type = 'creative_review'
    AND newer.active IS TRUE
    AND newer.preference_value->>'post_id' = p_manifest->'authority'->>'postId'
    AND (newer.created_at, newer.id) > (latest_approval.created_at, latest_approval.id);
  IF FOUND THEN RAISE EXCEPTION 'EXPORT_APPROVAL_SUPERSEDED'; END IF;

  approved := latest_approval.preference_value;
  source_evidence := coalesce(approved->'source_evidence', approved->'sourceEvidence');
  expected_composition := jsonb_build_object(
    'version', approved->'composition'->'version',
    'layout', approved->'composition'->'layout',
    'fontContract', approved->'composition'->'font_contract',
    'brandName', approved->'composition'->'brand_name',
    'imageRole', approved->'composition'->'image_role',
    'typographyOnly', approved->'composition'->'typography_only',
    'headline', approved->'composition'->'headline',
    'callToAction', approved->'composition'->'call_to_action',
    'captionSnapshot', draft.body);
  expected_source := jsonb_build_object(
    'kind', source_evidence->'kind',
    'identity', CASE source_evidence->>'kind'
      WHEN 'typography_only' THEN to_jsonb('typography-only'::text)
      WHEN 'upload' THEN coalesce(source_evidence->'storage_path', source_evidence->'storagePath', source_evidence->'identity')
      ELSE coalesce(source_evidence->'url', source_evidence->'identity') END,
    'sourceUrl', CASE WHEN source_evidence->>'kind' = 'source' THEN coalesce(approved->'image'->'source_url', approved->'image'->'sourceUrl', 'null'::jsonb) ELSE 'null'::jsonb END,
    'hash', coalesce(source_evidence->'hash', source_evidence->'sha256', 'null'::jsonb),
    'objectVersion', coalesce(source_evidence->'object_version', source_evidence->'objectVersion', CASE WHEN source_evidence->>'kind' = 'upload' THEN source_evidence->'revision' END, 'null'::jsonb),
    'revision', CASE WHEN source_evidence->>'kind' = 'source' THEN coalesce(source_evidence->'revision', source_evidence->'source_revision', source_evidence->'sourceRevision', 'null'::jsonb) ELSE 'null'::jsonb END,
    'mediaType', coalesce(source_evidence->'media_type', source_evidence->'mediaType', source_evidence->'content_type', source_evidence->'contentType', 'null'::jsonb),
    'byteLength', coalesce(source_evidence->'byte_length', source_evidence->'byteLength', '0'::jsonb));
  IF p_manifest->'composition' IS DISTINCT FROM expected_composition
    OR approved->'headline' IS DISTINCT FROM approved->'composition'->'headline'
    OR approved->'call_to_action' IS DISTINCT FROM approved->'composition'->'call_to_action'
    OR (CASE WHEN approved->'image' IS NULL OR approved->'image' = 'null'::jsonb THEN 'typography_only'
        ELSE approved->'image'->>'kind' END) IS DISTINCT FROM expected_source->>'kind'
    OR (expected_source->>'kind' = 'upload' AND approved->'image'->'storage_path' IS DISTINCT FROM expected_source->'identity')
    OR (expected_source->>'kind' = 'source' AND approved->'image'->'url' IS DISTINCT FROM expected_source->'identity')
    OR hash_payload->'source' IS DISTINCT FROM expected_source
    OR encode(sha256(convert_to(draft.body, 'UTF8')), 'hex') IS DISTINCT FROM p_manifest->'authority'->>'contentHash'
    OR p_manifest->'authority'->'sourceHash' IS DISTINCT FROM expected_source->'hash'
    OR p_manifest->'authority'->'sourceKind' IS DISTINCT FROM expected_source->'kind'
    OR p_manifest->'authority'->'sourceIdentity' IS DISTINCT FROM expected_source->'identity'
    OR (p_manifest->'authority'->>'approvedAt')::timestamptz IS DISTINCT FROM (approved->>'approved_at')::timestamptz
    OR approved->>'artwork_contract_version' IS DISTINCT FROM 'meta_organic_creative_composition_v2'
    OR p_manifest->'output'->'hash' IS DISTINCT FROM approved->'final_render_evidence'->'hash'
    OR p_manifest->'output'->'byteLength' IS DISTINCT FROM approved->'final_render_evidence'->'byteLength'
    OR p_manifest->'output'->'mediaType' IS DISTINCT FROM approved->'final_render_evidence'->'mediaType'
    OR p_manifest->'output'->'dimensions' IS DISTINCT FROM approved->'final_render_evidence'->'dimensions'
    OR p_manifest->'authority'->'rendererVersion' IS DISTINCT FROM approved->'final_render_evidence'->'rendererVersion'
    OR p_manifest->'output'->'dimensions' IS DISTINCT FROM '{"width":1080,"height":1350}'::jsonb
    OR (p_manifest->'output'->>'byteLength')::integer NOT BETWEEN 1 AND 3145728
    OR (p_manifest->'output'->>'providerReadableUrlExpiresAt')::timestamptz <= now() THEN
    RAISE EXCEPTION 'EXPORT_REVIEWED_ARTWORK_CHANGED';
  END IF;

  SELECT * INTO existing
  FROM private.meta_organic_publish_exports
  WHERE manifest_hash = p_manifest->>'manifestHash';
  IF FOUND THEN
    RAISE EXCEPTION 'EXPORT_MANIFEST_IMMUTABLE';
  END IF;

  INSERT INTO private.meta_organic_publish_exports (
    manifest_hash, user_id, pod_id, draft_id, account_connection_id,
    media_type, byte_length, output_hash, provider_readable_url,
    provider_readable_url_expires_at, object_version, manifest, immutable,
    status, exported_at
  )
  VALUES (
    p_manifest->>'manifestHash',
    (p_manifest->'authority'->>'userId')::uuid,
    (p_manifest->'authority'->>'podId')::uuid,
    (p_manifest->'authority'->>'postId')::uuid,
    (p_manifest->'authority'->>'accountConnectionId')::uuid,
    p_manifest->'output'->>'mediaType',
    (p_manifest->'output'->>'byteLength')::integer,
    p_manifest->'output'->>'hash',
    p_manifest->'output'->>'providerReadableUrl',
    (p_manifest->'output'->>'providerReadableUrlExpiresAt')::timestamptz,
    p_manifest->'output'->>'objectPath',
    p_manifest,
    true,
    'exported',
    coalesce((p_manifest->>'createdAt')::timestamptz, now())
  )
  RETURNING * INTO inserted;

  RETURN jsonb_build_object(
    'manifestHash', inserted.manifest_hash,
    'userId', inserted.user_id,
    'podId', inserted.pod_id,
    'draftId', inserted.draft_id,
    'accountConnectionId', inserted.account_connection_id,
    'status', inserted.status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_meta_organic_reconciliation_job(
  p_worker_id TEXT,
  p_now TIMESTAMPTZ,
  p_lease_ms INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job_id UUID;
  job private.meta_organic_publish_jobs%ROWTYPE;
  receipt JSONB;
  account_id TEXT;
BEGIN
  IF btrim(coalesce(p_worker_id, '')) = '' OR p_lease_ms < 30000 OR p_lease_ms > 900000 THEN
    RAISE EXCEPTION 'PUBLISH_RECONCILE_CLAIM_INVALID';
  END IF;

  SELECT id INTO job_id
  FROM private.meta_organic_publish_jobs
  WHERE state = 'unknown'
    OR (state = 'reconciling' AND lease_expires_at <= p_now)
  ORDER BY updated_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF job_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE private.meta_organic_publish_jobs
  SET state = 'reconciling',
      leased_by = p_worker_id,
      operation_token = md5(private.meta_organic_publisher_uuid()::text || p_worker_id || p_now::text)
        || md5(p_worker_id || p_now::text || private.meta_organic_publisher_uuid()::text),
      lease_expires_at = p_now + (p_lease_ms || ' milliseconds')::interval,
      updated_at = p_now
  WHERE id = job_id
  RETURNING * INTO job;

  SELECT raw_receipt INTO receipt
  FROM private.meta_organic_publish_receipts
  WHERE private.meta_organic_publish_receipts.job_id = job.id
  ORDER BY created_at DESC
  LIMIT 1;

  SELECT provider_account_id INTO account_id
  FROM private.meta_organic_connections
  WHERE id = job.account_connection_id;

  receipt := coalesce(receipt, '{}'::jsonb) || jsonb_build_object(
    'provider', job.provider,
    'providerAccountId', account_id
  );

  RETURN private.meta_organic_job_json(job)
    || jsonb_build_object(
      'providerAccountId', account_id,
      'receipts', jsonb_build_object(job.account_connection_id, receipt)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_meta_organic_publish_blocked(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_reason TEXT,
  p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  PERFORM private.meta_organic_require_lease(p_job_id, p_worker_id, p_operation_token, false);
  UPDATE private.meta_organic_publish_jobs
  SET state = 'blocked', error_code = p_reason, details = coalesce(p_details, '{}'::jsonb),
      leased_by = NULL, operation_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO job;
  RETURN private.meta_organic_job_json(job);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_meta_organic_publish_retry(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_reason TEXT,
  p_details JSONB,
  p_retry_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE leased private.meta_organic_publish_jobs%ROWTYPE; job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  leased := private.meta_organic_require_lease(p_job_id, p_worker_id, p_operation_token, false);
  IF leased.attempts >= 4 THEN RAISE EXCEPTION 'PUBLISH_RETRY_EXHAUSTED'; END IF;
  UPDATE private.meta_organic_publish_jobs
  SET state = 'retry', attempts = attempts + 1, error_code = p_reason, details = coalesce(p_details, '{}'::jsonb),
      retry_at = p_retry_at, leased_by = NULL, operation_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO job;
  RETURN private.meta_organic_job_json(job);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_meta_organic_publish_failed(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_reason TEXT,
  p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  PERFORM private.meta_organic_require_lease(p_job_id, p_worker_id, p_operation_token, false);
  UPDATE private.meta_organic_publish_jobs
  SET state = 'failed', attempts = attempts + 1, error_code = p_reason, details = coalesce(p_details, '{}'::jsonb),
      leased_by = NULL, operation_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO job;
  RETURN private.meta_organic_job_json(job);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_meta_organic_publish_unknown(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_reason TEXT,
  p_receipt JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE leased private.meta_organic_publish_jobs%ROWTYPE; job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  leased := private.meta_organic_require_lease(p_job_id, p_worker_id, p_operation_token, true);
  UPDATE private.meta_organic_publish_jobs
  SET state = 'unknown', error_code = coalesce(p_reason, 'OUTCOME_UNKNOWN'), details = coalesce(p_receipt, '{}'::jsonb),
      leased_by = NULL, operation_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO job;

  INSERT INTO private.meta_organic_publish_receipts (
    job_id, account_connection_id, provider, provider_account_id, status,
    provider_post_id, permalink, raw_receipt
  )
  VALUES (
    job.id, job.account_connection_id, job.provider, coalesce(p_receipt->>'providerAccountId', 'unknown'),
    'unknown', p_receipt->>'providerPostId', p_receipt->>'permalink', coalesce(p_receipt, '{}'::jsonb)
  );

  RETURN private.meta_organic_job_json(job);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_meta_organic_publish_published(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_receipt JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  PERFORM private.meta_organic_require_lease(p_job_id, p_worker_id, p_operation_token, false);
  IF btrim(coalesce(p_receipt->>'providerAccountId', '')) = '' OR btrim(coalesce(p_receipt->>'providerPostId', '')) = '' THEN
    RAISE EXCEPTION 'PUBLISH_RECEIPT_REQUIRED';
  END IF;

  UPDATE private.meta_organic_publish_jobs
  SET state = 'published', error_code = NULL, details = coalesce(p_receipt, '{}'::jsonb),
      leased_by = NULL, operation_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO job;

  INSERT INTO private.meta_organic_publish_receipts (
    job_id, account_connection_id, provider, provider_account_id, status,
    provider_post_id, permalink, raw_receipt
  )
  VALUES (
    job.id, job.account_connection_id, job.provider, p_receipt->>'providerAccountId',
    'published', p_receipt->>'providerPostId', p_receipt->>'permalink', coalesce(p_receipt, '{}'::jsonb)
  );

  RETURN private.meta_organic_job_json(job);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_meta_organic_publish_reconciled(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_receipt JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  PERFORM private.meta_organic_require_reconciliation_claim(p_job_id, p_worker_id, p_operation_token);
  IF btrim(coalesce(p_receipt->>'providerAccountId', '')) = '' OR btrim(coalesce(p_receipt->>'providerPostId', '')) = '' THEN
    RAISE EXCEPTION 'PUBLISH_RECONCILE_RECEIPT_REQUIRED';
  END IF;

  UPDATE private.meta_organic_publish_jobs
  SET state = 'published', error_code = NULL, details = coalesce(p_receipt, '{}'::jsonb),
      leased_by = NULL, operation_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO job;

  INSERT INTO private.meta_organic_publish_receipts (
    job_id, account_connection_id, provider, provider_account_id, status,
    provider_post_id, permalink, raw_receipt
  )
  VALUES (
    job.id, job.account_connection_id, job.provider, p_receipt->>'providerAccountId',
    'reconciled', p_receipt->>'providerPostId', p_receipt->>'permalink', coalesce(p_receipt, '{}'::jsonb)
  );

  RETURN private.meta_organic_job_json(job);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_meta_organic_reconciliation_inconclusive(
  p_job_id UUID,
  p_worker_id TEXT,
  p_operation_token TEXT,
  p_reason TEXT,
  p_receipt JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE job private.meta_organic_publish_jobs%ROWTYPE;
BEGIN
  PERFORM private.meta_organic_require_reconciliation_claim(p_job_id, p_worker_id, p_operation_token);
  UPDATE private.meta_organic_publish_jobs
  SET state = 'unknown', error_code = coalesce(p_reason, 'RECONCILE_INCONCLUSIVE'), details = coalesce(p_receipt, '{}'::jsonb),
      leased_by = NULL, operation_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO job;
  RETURN private.meta_organic_job_json(job);
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_meta_organic_publish_job(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_meta_organic_publish_job(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_meta_organic_publish_context(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_meta_organic_publish_blocked(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_meta_organic_publish_retry(UUID, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_meta_organic_publish_failed(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_meta_organic_publish_unknown(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_meta_organic_publish_published(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_meta_organic_artwork_export_context(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_meta_organic_artwork_export_manifest(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_meta_organic_reconciliation_job(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_meta_organic_publish_reconciled(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_meta_organic_reconciliation_inconclusive(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.meta_organic_publisher_uuid() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.meta_organic_job_json(private.meta_organic_publish_jobs) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.meta_organic_require_lease(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.meta_organic_require_reconciliation_claim(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.enqueue_meta_organic_publish_job(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_meta_organic_publish_job(TEXT, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_meta_organic_publish_context(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_publish_blocked(UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_publish_retry(UUID, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_publish_failed(UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_publish_unknown(UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_publish_published(UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_meta_organic_artwork_export_context(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_meta_organic_artwork_export_manifest(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_meta_organic_reconciliation_job(TEXT, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_publish_reconciled(UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_reconciliation_inconclusive(UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION private.meta_organic_canonical_json(JSONB) FROM PUBLIC, anon, authenticated, service_role;
