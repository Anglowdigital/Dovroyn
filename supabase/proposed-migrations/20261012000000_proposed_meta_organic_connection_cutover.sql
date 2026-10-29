-- PROPOSED ONLY: Meta organic account connection cutover.
-- Do not apply without parent review, runtime config approval, and reconciliation
-- with stalled release branches. This migration intentionally does not enable
-- live publishing, paid ads, production OAuth, or any permission grant.
-- Explicit publishing connections remain separately disabled in runtime configuration.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

-- New Meta-only trust path. Existing public.social_connections rows and browser
-- grants are preserved for other providers, but are not trusted by the new Meta
-- status API. Legacy Meta rows require reconnect through this server flow.
CREATE TABLE IF NOT EXISTS private.meta_organic_oauth_states (
  state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_binding_hash TEXT NOT NULL CHECK (browser_binding_hash ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  requested_provider TEXT NOT NULL DEFAULT 'instagram' CHECK (requested_provider IN ('facebook','instagram')),
  connection_intent TEXT NOT NULL DEFAULT 'discovery' CHECK (connection_intent IN ('discovery','publish')),
  required_scopes TEXT[] NOT NULL DEFAULT ARRAY['instagram_basic','pages_show_list'],
  redirect_uri TEXT NOT NULL CHECK (redirect_uri ~ '^https://' AND length(redirect_uri) BETWEEN 10 AND 2048),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS private.meta_organic_pending_selections (
  selection_hash TEXT PRIMARY KEY CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  connection_intent TEXT NOT NULL DEFAULT 'discovery' CHECK (connection_intent IN ('discovery','publish')),
  requested_provider TEXT NOT NULL DEFAULT 'instagram' CHECK (requested_provider IN ('facebook','instagram')),
  granted_scopes TEXT[] NOT NULL,
  encrypted_access_token TEXT NOT NULL CHECK (length(encrypted_access_token) BETWEEN 43 AND 65536 AND encrypted_access_token ~ '^[A-Za-z0-9_-]+$'),
  encrypted_candidates TEXT NOT NULL CHECK (length(encrypted_candidates) BETWEEN 43 AND 65536 AND encrypted_candidates ~ '^[A-Za-z0-9_-]+$'),
  encryption_key_version TEXT NOT NULL CHECK (encryption_key_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS private.meta_organic_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('facebook','instagram')),
  connection_intent TEXT NOT NULL DEFAULT 'discovery' CHECK (connection_intent IN ('discovery','publish')),
  linked_facebook_page_id TEXT CHECK (linked_facebook_page_id IS NULL OR linked_facebook_page_id ~ '^[1-9][0-9]{0,31}$'),
  provider_account_id TEXT NOT NULL CHECK (provider_account_id ~ '^[1-9][0-9]{0,31}$'),
  account_label TEXT NOT NULL CHECK (length(trim(account_label)) BETWEEN 1 AND 120 AND account_label !~ '[[:cntrl:]]'),
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','expired','revoked','error','reconnect_required')),
  granted_scopes TEXT[] NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  provider_verified_source TEXT NOT NULL DEFAULT 'meta_organic_server_v1',
  provider_contract_version TEXT NOT NULL DEFAULT 'meta_organic_facebook_login_selection_v2',
  provider_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS private.meta_organic_credentials (
  connection_id UUID PRIMARY KEY REFERENCES private.meta_organic_connections(id) ON DELETE CASCADE,
  token_kind TEXT NOT NULL CHECK (token_kind IN ('user','page','none')),
  encrypted_access_token TEXT CHECK (encrypted_access_token IS NULL OR (length(encrypted_access_token) BETWEEN 43 AND 65536 AND encrypted_access_token ~ '^[A-Za-z0-9_-]+$')),
  encryption_key_version TEXT CHECK (encryption_key_version IS NULL OR encryption_key_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verification_metadata JSONB,
  CHECK (
    (token_kind = 'none' AND encrypted_access_token IS NULL AND encryption_key_version IS NULL)
    OR (token_kind IN ('user','page') AND encrypted_access_token IS NOT NULL AND encryption_key_version IS NOT NULL)
  )
);

-- Proposed compatibility extension: existing rows remain discovery records.
ALTER TABLE private.meta_organic_oauth_states ADD COLUMN IF NOT EXISTS connection_intent TEXT NOT NULL DEFAULT 'discovery' CHECK (connection_intent IN ('discovery','publish'));
ALTER TABLE private.meta_organic_pending_selections ADD COLUMN IF NOT EXISTS connection_intent TEXT NOT NULL DEFAULT 'discovery' CHECK (connection_intent IN ('discovery','publish'));
ALTER TABLE private.meta_organic_pending_selections ADD COLUMN IF NOT EXISTS requested_provider TEXT NOT NULL DEFAULT 'instagram' CHECK (requested_provider IN ('facebook','instagram'));
ALTER TABLE private.meta_organic_connections ADD COLUMN IF NOT EXISTS connection_intent TEXT NOT NULL DEFAULT 'discovery' CHECK (connection_intent IN ('discovery','publish'));
ALTER TABLE private.meta_organic_connections ADD COLUMN IF NOT EXISTS linked_facebook_page_id TEXT;
ALTER TABLE private.meta_organic_credentials ADD COLUMN IF NOT EXISTS verification_metadata JSONB;
DO $$
DECLARE old_constraint RECORD;
BEGIN
  FOR old_constraint IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'private.meta_organic_connections'::regclass AND c.contype = 'u'
      AND ARRAY(
        SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY key(attnum, position)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
        ORDER BY key.position
      ) = ARRAY['pod_id','provider','provider_account_id']::text[]
  LOOP
    EXECUTE format('ALTER TABLE private.meta_organic_connections DROP CONSTRAINT %I', old_constraint.conname);
  END LOOP;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS meta_organic_connection_identity_by_intent_idx
  ON private.meta_organic_connections (pod_id, provider, provider_account_id, connection_intent);

CREATE INDEX IF NOT EXISTS meta_organic_oauth_states_expiry_idx ON private.meta_organic_oauth_states (expires_at);
CREATE INDEX IF NOT EXISTS meta_organic_pending_selections_expiry_idx ON private.meta_organic_pending_selections (expires_at);
CREATE INDEX IF NOT EXISTS meta_organic_connections_owner_pod_idx ON private.meta_organic_connections (user_id, pod_id);

ALTER TABLE private.meta_organic_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meta_organic_pending_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meta_organic_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meta_organic_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.meta_organic_oauth_states, private.meta_organic_pending_selections,
  private.meta_organic_connections, private.meta_organic_credentials FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.meta_scope_valid(p_provider TEXT, p_scopes TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_scopes IS NOT NULL
    AND cardinality(p_scopes) BETWEEN 1 AND 64
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p_scopes) scope
      WHERE scope IS NULL OR scope !~ '^[a-z][a-z0-9_]{0,127}$'
    )
    AND CASE p_provider
      WHEN 'facebook' THEN p_scopes @> ARRAY['pages_show_list']
      WHEN 'instagram' THEN p_scopes @> ARRAY['instagram_basic','pages_show_list']
      ELSE false
    END;
$$;

CREATE OR REPLACE FUNCTION private.meta_store_connection(
  p_user_id UUID,
  p_pod_id UUID,
  p_payload JSONB,
  p_connection_intent TEXT DEFAULT 'discovery'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_id UUID;
  selected_provider TEXT := p_payload->>'provider';
  selected_scopes TEXT[] := COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_payload->'grantedScopes')), ARRAY[]::TEXT[]);
  selected_expires TIMESTAMPTZ := (p_payload->>'expiresAt')::TIMESTAMPTZ;
  selected_token_kind TEXT := COALESCE(p_payload->>'tokenKind', 'none');
  selected_token TEXT := NULLIF(p_payload->>'encryptedAccessToken', '');
  selected_key_version TEXT := NULLIF(p_payload->>'encryptionKeyVersion', '');
  proof JSONB := p_payload->'credentialProof';
  proof_scopes TEXT[];
  selected_contract TEXT := 'meta_organic_facebook_login_selection_v2';
BEGIN
  IF selected_provider NOT IN ('facebook','instagram') THEN
    RAISE EXCEPTION 'Invalid Meta provider';
  END IF;
  IF p_payload->>'providerAccountId' IS NULL OR p_payload->>'providerAccountId' !~ '^[1-9][0-9]{0,31}$' THEN
    RAISE EXCEPTION 'Invalid Meta account ID';
  END IF;
  IF p_payload->>'accountLabel' IS NULL OR length(trim(p_payload->>'accountLabel')) NOT BETWEEN 1 AND 120
    OR p_payload->>'accountLabel' ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid Meta account label';
  END IF;
  IF p_connection_intent IS NULL OR p_connection_intent NOT IN ('discovery','publish')
    OR (p_payload ? 'connectionIntent' AND p_payload->>'connectionIntent' IS DISTINCT FROM p_connection_intent)
    OR (p_connection_intent = 'publish' AND p_payload->>'connectionIntent' IS DISTINCT FROM 'publish') THEN
    RAISE EXCEPTION 'Invalid Meta connection intent';
  END IF;
  IF NOT private.meta_scope_valid(selected_provider, selected_scopes)
    OR (p_connection_intent = 'publish' AND NOT private.meta_publish_scope_valid(selected_provider, selected_scopes)) THEN
    RAISE EXCEPTION 'Invalid Meta scopes';
  END IF;
  IF selected_expires IS NULL OR selected_expires <= now() + interval '1 minute' THEN
    RAISE EXCEPTION 'Meta token is already expired';
  END IF;
  IF selected_token_kind NOT IN ('user','page','none') THEN
    RAISE EXCEPTION 'Invalid Meta token kind';
  END IF;
  IF selected_provider = 'facebook' AND selected_token_kind <> 'page' THEN
    RAISE EXCEPTION 'Facebook Page credentials must be Page tokens when present';
  END IF;
  IF selected_provider = 'instagram' AND p_connection_intent = 'discovery' AND selected_token_kind <> 'user' THEN
    RAISE EXCEPTION 'Instagram discovery credentials must use the user token';
  END IF;
  IF p_connection_intent = 'publish' THEN
    IF selected_token_kind <> 'page' THEN RAISE EXCEPTION 'Publishing credentials must be Page tokens'; END IF;
    IF p_payload->>'providerContractVersion' IS DISTINCT FROM 'meta_organic_facebook_login_publish_selection_v1'
      OR p_payload->>'providerVerifiedSource' IS DISTINCT FROM 'meta_organic_server_v1'
      OR jsonb_typeof(proof) IS DISTINCT FROM 'object'
      OR proof->>'source' IS DISTINCT FROM 'meta_page_token_debug_v1'
      OR proof->>'tokenKind' IS DISTINCT FROM 'page'
      OR proof->>'appId' IS NULL OR proof->>'appId' !~ '^[1-9][0-9]{0,31}$'
      OR proof->>'pageId' IS NULL OR proof->>'pageId' !~ '^[1-9][0-9]{0,31}$'
      OR proof->>'pageId' IS DISTINCT FROM p_payload->>'linkedFacebookPageId'
      OR proof->>'tokenHash' IS NULL OR proof->>'tokenHash' !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(proof->'grantedScopes') IS DISTINCT FROM 'array'
      OR proof->>'expiresAt' IS NULL OR (proof->>'expiresAt')::TIMESTAMPTZ < selected_expires
      OR proof->>'verifiedAt' IS NULL OR (proof->>'verifiedAt')::TIMESTAMPTZ > now() + interval '1 minute'
      OR (selected_provider = 'facebook' AND proof->>'pageId' IS DISTINCT FROM p_payload->>'providerAccountId')
      OR (selected_provider = 'instagram' AND proof->>'linkedInstagramAccountId' IS DISTINCT FROM p_payload->>'providerAccountId') THEN
      RAISE EXCEPTION 'Invalid Page publishing credential proof or account contract';
    END IF;
    proof_scopes := ARRAY(SELECT jsonb_array_elements_text(proof->'grantedScopes'));
    IF NOT private.meta_publish_scope_valid(selected_provider, proof_scopes) THEN RAISE EXCEPTION 'Invalid Page permission scope proof'; END IF;
    selected_contract := 'meta_organic_facebook_login_publish_selection_v1';
  END IF;

  INSERT INTO private.meta_organic_connections (
    user_id, pod_id, provider, provider_account_id, account_label, status,
    granted_scopes, connected_at, expires_at, last_error, updated_at,
    provider_verified_source, provider_verified_at, provider_contract_version, connection_intent, linked_facebook_page_id
  )
  VALUES (
    p_user_id, p_pod_id, selected_provider, p_payload->>'providerAccountId', trim(p_payload->>'accountLabel'), 'connected',
    selected_scopes, now(), selected_expires, NULL, now(),
    'meta_organic_server_v1', now(), selected_contract, p_connection_intent,
    CASE WHEN p_connection_intent = 'publish' THEN p_payload->>'linkedFacebookPageId' ELSE NULL END
  )
  ON CONFLICT (pod_id, provider, provider_account_id, connection_intent)
  DO UPDATE SET
    user_id = EXCLUDED.user_id,
    account_label = EXCLUDED.account_label,
    status = 'connected',
    granted_scopes = EXCLUDED.granted_scopes,
    connected_at = now(),
    expires_at = EXCLUDED.expires_at,
    last_error = NULL,
    updated_at = now(),
    provider_verified_source = EXCLUDED.provider_verified_source,
    provider_verified_at = EXCLUDED.provider_verified_at,
    provider_contract_version = EXCLUDED.provider_contract_version,
    linked_facebook_page_id = EXCLUDED.linked_facebook_page_id
  RETURNING id INTO target_id;

  INSERT INTO private.meta_organic_credentials (
    connection_id, token_kind, encrypted_access_token, encryption_key_version, updated_at, verification_metadata
  )
  VALUES (target_id, selected_token_kind, selected_token, selected_key_version, now(),
    CASE WHEN p_connection_intent = 'publish' THEN proof ELSE NULL END)
  ON CONFLICT (connection_id)
  DO UPDATE SET
    token_kind = EXCLUDED.token_kind,
    encrypted_access_token = EXCLUDED.encrypted_access_token,
    encryption_key_version = EXCLUDED.encryption_key_version,
    updated_at = now(),
    verification_metadata = EXCLUDED.verification_metadata;

  RETURN target_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_meta_organic_connection_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH checks AS (
    SELECT
      to_regclass('private.meta_organic_oauth_states') IS NOT NULL
        AND to_regclass('private.meta_organic_pending_selections') IS NOT NULL
        AND to_regclass('private.meta_organic_connections') IS NOT NULL
        AND to_regclass('private.meta_organic_credentials') IS NOT NULL AS private_tables_ready,
      COALESCE(has_function_privilege('service_role', to_regprocedure('public.get_meta_organic_connection_readiness()'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege('service_role', to_regprocedure('public.create_meta_organic_oauth_state(text,text,uuid,uuid,text,text,text[],timestamp with time zone)'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege('service_role', to_regprocedure('public.consume_meta_organic_oauth_state(text,text)'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege('service_role', to_regprocedure('public.create_meta_organic_pending_selection(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text[],text,text,text)'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege('service_role', to_regprocedure('public.get_meta_organic_pending_selection(text,uuid,uuid)'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege('service_role', to_regprocedure('public.commit_meta_organic_account_selection(text,uuid,uuid,jsonb,jsonb)'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege('service_role', to_regprocedure('public.list_meta_organic_connections(uuid,uuid)'), 'EXECUTE'), false) AS service_execute_ready,
      NOT COALESCE(has_function_privilege('authenticated', to_regprocedure('public.commit_meta_organic_account_selection(text,uuid,uuid,jsonb,jsonb)'), 'EXECUTE'), false)
        AND NOT COALESCE(has_table_privilege('authenticated', 'private.meta_organic_connections', 'SELECT'), false)
        AND NOT COALESCE(has_table_privilege('anon', 'private.meta_organic_credentials', 'SELECT'), false) AS browser_private_access_denied,
      COALESCE(has_function_privilege('service_role', to_regprocedure('public.create_meta_organic_publish_oauth_state(text,text,uuid,uuid,text,text,text[],timestamp with time zone)'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege('service_role', to_regprocedure('public.create_meta_organic_publish_pending_selection(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text[],text,text,text,text)'), 'EXECUTE'), false)
        AND NOT COALESCE(has_function_privilege('authenticated', to_regprocedure('public.create_meta_organic_publish_oauth_state(text,text,uuid,uuid,text,text,text[],timestamp with time zone)'), 'EXECUTE'), false)
        AND NOT COALESCE(has_function_privilege('anon', to_regprocedure('public.create_meta_organic_publish_pending_selection(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text[],text,text,text,text)'), 'EXECUTE'), false)
        AND NOT COALESCE(has_function_privilege('authenticated', to_regprocedure('public.create_meta_organic_publish_pending_selection(text,uuid,uuid,timestamp with time zone,timestamp with time zone,text[],text,text,text,text)'), 'EXECUTE'), false)
        AND NOT COALESCE(has_function_privilege('anon', to_regprocedure('public.create_meta_organic_publish_oauth_state(text,text,uuid,uuid,text,text,text[],timestamp with time zone)'), 'EXECUTE'), false)
        AND (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = 'private'
          AND table_name IN ('meta_organic_oauth_states','meta_organic_pending_selections','meta_organic_connections') AND column_name = 'connection_intent')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'private' AND table_name = 'meta_organic_credentials' AND column_name = 'verification_metadata')
        AS publish_contract_ready
  )
  SELECT jsonb_build_object(
    'ready', private_tables_ready AND service_execute_ready AND browser_private_access_denied,
    'contract_version', 'meta_organic_facebook_login_selection_v2',
    'provider', 'meta',
    'login_route', 'facebook_login_for_instagram_api',
    'required_scopes', ARRAY['instagram_basic','pages_show_list'],
    'publish_connection_ready', private_tables_ready AND service_execute_ready AND browser_private_access_denied AND publish_contract_ready,
    'publish_connection_contract_version', 'meta_organic_facebook_login_publish_selection_v1',
    'provider_verified_source', 'meta_organic_server_v1',
    'checks', jsonb_build_object(
      'private_tables_ready', private_tables_ready,
      'service_execute_ready', service_execute_ready,
      'browser_private_access_denied', browser_private_access_denied
    )
  )
  FROM checks;
$$;

CREATE OR REPLACE FUNCTION public.create_meta_organic_oauth_state(
  p_state_hash TEXT,
  p_browser_binding_hash TEXT,
  p_user_id UUID,
  p_pod_id UUID,
  p_redirect_uri TEXT,
  p_requested_provider TEXT,
  p_required_scopes TEXT[],
  p_expires_at TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$'
    OR p_browser_binding_hash IS NULL OR p_browser_binding_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid OAuth state';
  END IF;
  IF p_redirect_uri IS NULL OR p_redirect_uri !~ '^https://' OR length(p_redirect_uri) > 2048 THEN
    RAISE EXCEPTION 'Invalid OAuth redirect URI';
  END IF;
  IF p_requested_provider NOT IN ('facebook','instagram') OR NOT private.meta_scope_valid(p_requested_provider, p_required_scopes) THEN
    RAISE EXCEPTION 'Invalid OAuth provider scope contract';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'Invalid OAuth state expiry';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;

  DELETE FROM private.meta_organic_oauth_states WHERE expires_at <= now();
  INSERT INTO private.meta_organic_oauth_states (
    state_hash, browser_binding_hash, user_id, pod_id, requested_provider, required_scopes, redirect_uri, expires_at
  )
  VALUES (
    p_state_hash, p_browser_binding_hash, p_user_id, p_pod_id, p_requested_provider, p_required_scopes, p_redirect_uri, p_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_meta_organic_oauth_state(
  p_state_hash TEXT,
  p_browser_binding_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  consumed private.meta_organic_oauth_states%ROWTYPE;
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$'
    OR p_browser_binding_hash IS NULL OR p_browser_binding_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN NULL;
  END IF;
  DELETE FROM private.meta_organic_oauth_states oauth_state
  WHERE oauth_state.state_hash = p_state_hash
    AND oauth_state.browser_binding_hash = p_browser_binding_hash
    AND oauth_state.expires_at > now()
  RETURNING * INTO consumed;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'user_id', consumed.user_id,
    'pod_id', consumed.pod_id,
    'redirect_uri', consumed.redirect_uri,
    'requested_provider', consumed.requested_provider,
    'connection_intent', consumed.connection_intent,
    'required_scopes', consumed.required_scopes
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_meta_organic_pending_selection(
  p_selection_hash TEXT,
  p_user_id UUID,
  p_pod_id UUID,
  p_expires_at TIMESTAMPTZ,
  p_token_expires_at TIMESTAMPTZ,
  p_granted_scopes TEXT[],
  p_encrypted_access_token TEXT,
  p_encrypted_candidates TEXT,
  p_encryption_key_version TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_selection_hash IS NULL OR p_selection_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid Meta selection';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '15 minutes'
    OR p_token_expires_at IS NULL OR p_token_expires_at <= now() + interval '1 minute' THEN
    RAISE EXCEPTION 'Invalid Meta selection expiry';
  END IF;
  IF p_encrypted_access_token IS NULL OR p_encrypted_candidates IS NULL
    OR length(p_encrypted_access_token) NOT BETWEEN 43 AND 65536
    OR p_encrypted_access_token !~ '^[A-Za-z0-9_-]+$'
    OR length(p_encrypted_candidates) NOT BETWEEN 43 AND 65536
    OR p_encrypted_candidates !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid encrypted Meta selection';
  END IF;
  DELETE FROM private.meta_organic_pending_selections WHERE expires_at <= now();
  INSERT INTO private.meta_organic_pending_selections (
    selection_hash, user_id, pod_id, expires_at, token_expires_at, granted_scopes,
    encrypted_access_token, encrypted_candidates, encryption_key_version
  )
  VALUES (
    p_selection_hash, p_user_id, p_pod_id, p_expires_at, p_token_expires_at, p_granted_scopes,
    p_encrypted_access_token, p_encrypted_candidates, p_encryption_key_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_meta_organic_pending_selection(
  p_selection_hash TEXT,
  p_user_id UUID,
  p_pod_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'connection_intent', connection_intent,
    'requested_provider', requested_provider,
    'user_id', user_id,
    'pod_id', pod_id,
    'encrypted_access_token', encrypted_access_token,
    'encrypted_candidates', encrypted_candidates,
    'granted_scopes', granted_scopes,
    'token_expires_at', token_expires_at,
    'encryption_key_version', encryption_key_version
  )
  FROM private.meta_organic_pending_selections pending
  WHERE pending.selection_hash = p_selection_hash
    AND pending.user_id = p_user_id
    AND pending.pod_id = p_pod_id
    AND pending.expires_at > now()
    AND pending.token_expires_at > now() + interval '1 minute';
$$;

CREATE OR REPLACE FUNCTION public.commit_meta_organic_account_selection(
  p_selection_hash TEXT,
  p_user_id UUID,
  p_pod_id UUID,
  p_facebook_page JSONB,
  p_instagram_account JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pending private.meta_organic_pending_selections%ROWTYPE;
  facebook_connection UUID;
  instagram_connection UUID;
  output JSONB := '[]'::JSONB;
BEGIN
  IF p_selection_hash IS NULL OR p_selection_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN NULL;
  END IF;
  IF p_facebook_page IS NULL AND p_instagram_account IS NULL THEN
    RAISE EXCEPTION 'Choose a Meta account';
  END IF;

  IF (p_facebook_page IS NOT NULL AND p_facebook_page->>'provider' IS DISTINCT FROM 'facebook')
    OR (p_instagram_account IS NOT NULL AND p_instagram_account->>'provider' IS DISTINCT FROM 'instagram') THEN
    RAISE EXCEPTION 'Invalid Meta account provider contract';
  END IF;

  SELECT * INTO pending
  FROM private.meta_organic_pending_selections row
  WHERE row.selection_hash = p_selection_hash
    AND row.user_id = p_user_id
    AND row.pod_id = p_pod_id
    AND row.expires_at > now()
    AND row.token_expires_at > now() + interval '1 minute'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = p_user_id) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;

  IF pending.connection_intent = 'publish' THEN
    IF (pending.requested_provider = 'instagram' AND (p_facebook_page IS NOT NULL OR p_instagram_account IS NULL))
      OR (pending.requested_provider = 'facebook' AND (p_instagram_account IS NOT NULL OR p_facebook_page IS NULL))
      OR NOT private.meta_publish_scope_valid(pending.requested_provider, pending.granted_scopes) THEN
      RAISE EXCEPTION 'Invalid publishing provider intent or scopes';
    END IF;
  END IF;
  IF p_facebook_page IS NOT NULL THEN
    facebook_connection := private.meta_store_connection(p_user_id, p_pod_id, p_facebook_page, pending.connection_intent);
    output := output || jsonb_build_array(jsonb_build_object(
      'provider', 'facebook',
      'connectionId', facebook_connection,
      'accountLabel', p_facebook_page->>'accountLabel'
    ));
  END IF;
  IF p_instagram_account IS NOT NULL THEN
    instagram_connection := private.meta_store_connection(p_user_id, p_pod_id, p_instagram_account, pending.connection_intent);
    output := output || jsonb_build_array(jsonb_build_object(
      'provider', 'instagram',
      'connectionId', instagram_connection,
      'accountLabel', p_instagram_account->>'accountLabel'
    ));
  END IF;

  DELETE FROM private.meta_organic_pending_selections row
  WHERE row.selection_hash = p_selection_hash
    AND row.user_id = p_user_id
    AND row.pod_id = p_pod_id;

  RETURN jsonb_build_object('connections', output);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_meta_organic_connections(
  p_user_id UUID,
  p_pod_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'provider', provider,
    'connection_intent', connection_intent,
    'linked_facebook_page_id', linked_facebook_page_id,
    'provider_account_id', provider_account_id,
    'account_label', account_label,
    'status', CASE WHEN expires_at <= now() THEN 'expired' ELSE status END,
    'granted_scopes', granted_scopes,
    'connected_at', connected_at,
    'expires_at', expires_at,
    'updated_at', updated_at,
    'provider_verified_source', provider_verified_source,
    'provider_contract_version', provider_contract_version
  ) ORDER BY provider, account_label), '[]'::JSONB)
  FROM private.meta_organic_connections connection
  WHERE connection.user_id = p_user_id
    AND connection.pod_id = p_pod_id
    AND EXISTS (SELECT 1 FROM public.pods pod WHERE pod.id = p_pod_id AND pod.user_id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION private.meta_publish_scope_valid(p_provider TEXT, p_scopes TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_scopes IS NOT NULL AND private.meta_scope_valid(p_provider, p_scopes)
    AND CASE p_provider
      WHEN 'facebook' THEN cardinality(p_scopes) = 3 AND p_scopes @> ARRAY['pages_show_list','pages_manage_posts','pages_read_engagement']
      WHEN 'instagram' THEN cardinality(p_scopes) = 4 AND p_scopes @> ARRAY['instagram_basic','pages_show_list','instagram_content_publish','pages_read_engagement']
      ELSE false
    END;
$$;

CREATE OR REPLACE FUNCTION public.create_meta_organic_publish_oauth_state(
  p_state_hash TEXT, p_browser_binding_hash TEXT, p_user_id UUID, p_pod_id UUID,
  p_redirect_uri TEXT, p_requested_provider TEXT, p_required_scopes TEXT[], p_expires_at TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.meta_publish_scope_valid(p_requested_provider, p_required_scopes) THEN
    RAISE EXCEPTION 'Invalid publishing scope contract';
  END IF;
  PERFORM public.create_meta_organic_oauth_state(p_state_hash, p_browser_binding_hash, p_user_id, p_pod_id,
    p_redirect_uri, p_requested_provider, p_required_scopes, p_expires_at);
  UPDATE private.meta_organic_oauth_states SET connection_intent = 'publish' WHERE state_hash = p_state_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_meta_organic_publish_pending_selection(
  p_selection_hash TEXT, p_user_id UUID, p_pod_id UUID, p_expires_at TIMESTAMPTZ,
  p_token_expires_at TIMESTAMPTZ, p_granted_scopes TEXT[], p_encrypted_access_token TEXT,
  p_encrypted_candidates TEXT, p_encryption_key_version TEXT, p_requested_provider TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.meta_publish_scope_valid(p_requested_provider, p_granted_scopes) THEN
    RAISE EXCEPTION 'Invalid publishing scope contract';
  END IF;
  PERFORM public.create_meta_organic_pending_selection(p_selection_hash, p_user_id, p_pod_id, p_expires_at,
    p_token_expires_at, p_granted_scopes, p_encrypted_access_token, p_encrypted_candidates, p_encryption_key_version);
  UPDATE private.meta_organic_pending_selections SET connection_intent = 'publish', requested_provider = p_requested_provider
    WHERE selection_hash = p_selection_hash AND user_id = p_user_id AND pod_id = p_pod_id;
END;
$$;

REVOKE ALL ON FUNCTION private.meta_publish_scope_valid(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_meta_organic_publish_oauth_state(TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_meta_organic_publish_pending_selection(TEXT, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_meta_organic_publish_oauth_state(TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_meta_organic_publish_pending_selection(TEXT, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION private.meta_scope_valid(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.meta_store_connection(UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_meta_organic_connection_readiness() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_meta_organic_oauth_state(TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_meta_organic_oauth_state(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_meta_organic_pending_selection(TEXT, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_meta_organic_pending_selection(TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_meta_organic_account_selection(TEXT, UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_meta_organic_connections(UUID, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_meta_organic_connection_readiness() TO service_role;
GRANT EXECUTE ON FUNCTION public.create_meta_organic_oauth_state(TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_meta_organic_oauth_state(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_meta_organic_pending_selection(TEXT, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_meta_organic_pending_selection(TEXT, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_meta_organic_account_selection(TEXT, UUID, UUID, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_meta_organic_connections(UUID, UUID) TO service_role;

-- Publisher functions and pages_manage_posts remain intentionally not granted/enabled.

COMMIT;
