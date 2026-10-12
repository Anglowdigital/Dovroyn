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
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  provider_readable_url TEXT NOT NULL CHECK (provider_readable_url ~ '^https://'),
  object_version TEXT NOT NULL,
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
    AND media_type = 'image/jpeg'
    AND immutable
    AND status = 'exported';
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_EXPORT_CONTEXT_REQUIRED'; END IF;

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
      'manifestHash', export_row.manifest_hash,
      'providerReadableUrl', export_row.provider_readable_url,
      'status', export_row.status,
      'immutable', export_row.immutable,
      'mediaType', export_row.media_type
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
GRANT EXECUTE ON FUNCTION public.claim_meta_organic_reconciliation_job(TEXT, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_publish_reconciled(UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_meta_organic_reconciliation_inconclusive(UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;
