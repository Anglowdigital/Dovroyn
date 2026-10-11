-- PROPOSED ONLY: Meta organic account connection cutover.
-- Do not apply without parent review, runtime config approval, and reconciliation
-- with PR48 plus any stalled release branches. This migration intentionally does
-- not enable Instagram publishing or request/use pages_manage_posts.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

-- Cutover principle: provider-verified connection status is written only by
-- reviewed server-side RPCs. Browser clients may read their own connection
-- status through RLS, but cannot forge connected state.
GRANT SELECT ON TABLE public.social_connections TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.social_connections FROM authenticated;
REVOKE ALL ON TABLE private.social_credentials FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.meta_organic_oauth_states (
  state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_binding_hash TEXT NOT NULL CHECK (browser_binding_hash ~ '^[a-f0-9]{64}$'),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pod_id UUID NOT NULL REFERENCES public.pods(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL CHECK (redirect_uri ~ '^https://' AND length(redirect_uri) BETWEEN 10 AND 2048),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_organic_oauth_states_expiry_idx
  ON private.meta_organic_oauth_states (expires_at);

ALTER TABLE private.meta_organic_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.meta_organic_oauth_states FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_meta_organic_connection_readiness()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'ready', true,
    'contract_version', 'meta_organic_facebook_login_v1',
    'provider', 'instagram',
    'login_route', 'facebook_login_for_instagram_api',
    'required_scopes', ARRAY['instagram_basic','pages_show_list']
  );
$$;

CREATE OR REPLACE FUNCTION public.create_meta_organic_oauth_state(
  p_state_hash TEXT,
  p_browser_binding_hash TEXT,
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
  IF p_browser_binding_hash IS NULL OR p_browser_binding_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid OAuth browser binding hash';
  END IF;
  IF p_redirect_uri IS NULL OR p_redirect_uri !~ '^https://' OR length(p_redirect_uri) > 2048 THEN
    RAISE EXCEPTION 'Invalid OAuth redirect URI';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'Invalid OAuth state expiry';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pods pod
    WHERE pod.id = p_pod_id AND pod.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;

  DELETE FROM private.meta_organic_oauth_states WHERE expires_at <= now();

  INSERT INTO private.meta_organic_oauth_states (
    state_hash, browser_binding_hash, user_id, pod_id, redirect_uri, expires_at
  )
  VALUES (
    p_state_hash, p_browser_binding_hash, p_user_id, p_pod_id, p_redirect_uri, p_expires_at
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

CREATE OR REPLACE FUNCTION public.store_meta_organic_connection(
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
  required_scopes CONSTANT TEXT[] := ARRAY['instagram_basic','pages_show_list'];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pods pod
    WHERE pod.id = p_pod_id AND pod.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Pod not found';
  END IF;
  IF p_provider_account_id IS NULL OR p_provider_account_id !~ '^[1-9][0-9]{0,31}$' THEN
    RAISE EXCEPTION 'Invalid Instagram account ID';
  END IF;
  IF p_account_label IS NULL OR length(trim(p_account_label)) NOT BETWEEN 1 AND 120
    OR p_account_label ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid Instagram account label';
  END IF;
  IF p_granted_scopes IS NULL
    OR NOT (p_granted_scopes @> required_scopes)
    OR p_granted_scopes && ARRAY['pages_manage_posts']
    OR cardinality(p_granted_scopes) > 64
    OR EXISTS (
      SELECT 1 FROM unnest(p_granted_scopes) scope
      WHERE scope IS NULL OR scope !~ '^[a-z][a-z0-9_]{0,127}$'
    ) THEN
    RAISE EXCEPTION 'Invalid Instagram scopes';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() + interval '1 minute' THEN
    RAISE EXCEPTION 'Instagram token is already expired';
  END IF;
  IF p_encrypted_access_token IS NULL
    OR length(p_encrypted_access_token) NOT BETWEEN 43 AND 65536
    OR p_encrypted_access_token !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid encrypted Instagram token';
  END IF;
  IF p_encryption_key_version IS NULL
    OR p_encryption_key_version !~ '^[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'Invalid encryption key version';
  END IF;

  INSERT INTO public.social_connections (
    pod_id, provider, provider_account_id, account_label, status,
    granted_scopes, connected_at, expires_at, last_error, updated_at
  )
  VALUES (
    p_pod_id, 'instagram', p_provider_account_id, trim(p_account_label), 'connected',
    p_granted_scopes, now(), p_expires_at, NULL, now()
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
    connection_id, encrypted_access_token, encrypted_refresh_token,
    encryption_key_version, updated_at
  )
  VALUES (
    target_connection_id, convert_to(p_encrypted_access_token, 'UTF8'), NULL,
    p_encryption_key_version, now()
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

REVOKE ALL ON FUNCTION public.get_meta_organic_connection_readiness()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_meta_organic_oauth_state(
  TEXT, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_meta_organic_oauth_state(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_meta_organic_connection(
  UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_meta_organic_connection_readiness()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_meta_organic_oauth_state(
  TEXT, TEXT, UUID, UUID, TEXT, TIMESTAMPTZ
) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_meta_organic_oauth_state(TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.store_meta_organic_connection(
  UUID, UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

-- Publisher functions and constraints from customer_release_expansion remain
-- unchanged and are intentionally not granted/enabled by this discovery cutover.
