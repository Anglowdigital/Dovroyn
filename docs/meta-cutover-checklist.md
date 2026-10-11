# PR48 + PR49: concrete Meta cutover decision

Inputs: PR48 `3b211a76007042f019e124031e032ec408aeb7e3` and PR49 `ccdb28ded52f9e41b7f9c848fcf2e2b027dd37da`, common main `fbf4dd9153d4473a8a654d9ed843aba0144aa104`. PR49 optional-logo migration is already applied according to the parent; do not reapply it as a new action.

## Dormant release

The integrated source is suitable for a dormant Meta release **only with `META_ORGANIC_CONNECTIONS_ENABLED` absent or not equal to the exact string `true`**. Connect and callback fail closed; the UI reports unavailable. Current live environment values were not inspected or modified. This conclusion does not approve merging/deploying or establish that an external deployment pipeline is disabled.

Integration moves the unapproved SQL from `supabase/migrations/20261012000000_proposed_meta_organic_connection_cutover.sql` to `supabase/proposed-migrations/20261012000000_proposed_meta_organic_connection_cutover.sql`. Its bytes are unchanged. A filename/comment saying “proposed” alone did not protect the original PR48 file from migration tooling. The moved file must be deliberately promoted or applied after approval; normal migration discovery should not apply it. No migration-running workflow is checked into this repository; remote CI/settings were not audited.

## Exact database approval

Approve a single transactional cutover in the **Dovroyn Supabase project**, executed as its trusted migration owner. Do not run through an end-user token. Review/back up affected connection metadata and count legacy rows first.

| Object | Recipient | Change |
|---|---|---|
| `private` schema | `PUBLIC`, `anon`, `authenticated` | Revoke all schema privileges (USAGE/CREATE). |
| `public.social_connections` | `authenticated` | Grant SELECT; revoke INSERT, UPDATE, DELETE. Existing owner RLS remains responsible for row visibility. |
| `public.social_connections` | `anon`, `PUBLIC` | Revoke INSERT, UPDATE, DELETE. |
| `private.social_credentials` | `PUBLIC`, `anon`, `authenticated` | Revoke all table privileges. |
| new `private.meta_organic_oauth_states` | `PUBLIC`, `anon`, `authenticated` | Revoke all table privileges; enable RLS with no client policy. |
| Four new public RPCs listed below | `PUBLIC`, `anon`, `authenticated` | Revoke all function privileges. |
| Same four RPCs | `service_role` | Grant EXECUTE only. No direct private-table grant is added. |

RPCs are `SECURITY DEFINER` with empty `search_path`; their owner executes private storage operations:

1. `get_meta_organic_connection_readiness()` → JSON readiness/contract/ACL evidence.
2. `create_meta_organic_oauth_state(text,text,uuid,uuid,text,timestamptz)` → hashed state + independent browser binding, ownership and expiry validation.
3. `consume_meta_organic_oauth_state(text,text)` → atomically deletes one matching unexpired state and returns trusted user/pod/redirect context.
4. `store_meta_organic_connection(uuid,uuid,text,text,text[],timestamptz,text,text)` → validates owner, account, discovery scopes and expiry; upserts connection + encrypted private credential.

Schema/data effects: add `provider_verified_source text`, `provider_verified_at timestamptz`, `provider_contract_version text` and provenance index to `social_connections`; create private state table with user/pod cascading foreign keys and expiry index. Legacy Instagram rows marked `connected` without the expected provenance/contract become `expired`, receive reconnect-required messaging, and retain rows/credentials. New storage marks verified rows connected, writes encrypted access token/key version, and sets encrypted refresh token NULL for that connection.

Risks to explicitly accept: browser-write revocation affects **every provider** in `social_connections`, not just Instagram; any separate browser-based connect/disconnect writer will stop working. Private-schema revocation affects other client uses of that schema. The service role gains four powerful RPCs and must remain server-only. Existing owner RLS, migration owner privileges, private credential schema, and absence of unexpected inherited/column grants require target-project verification. Legacy users must reconnect. Key loss prevents decrypting stored credentials; plan protected key retention/rotation. Existing publisher RPC grants and publishing constraints are unchanged and publishing stays disabled.

After applying: inspect effective ACLs and run readiness as `service_role` (ready=true, contract `meta_organic_facebook_login_v1`, provenance `meta_organic_server_v1`); verify authenticated and anonymous users cannot mutate connection rows, read private credentials/states, or execute the RPCs, and cross-tenant reads remain denied. Isolated PGlite validation is evidence of SQL behavior, not proof of deployed Supabase roles/RLS.

## Exact server configuration approval

Install values only in the Dovroyn application's **Vercel project → Settings → Environment Variables**, scoped to the intended environment (Production for dovroyn.com; use an explicitly registered development callback for a separate test deployment). Use the trusted dashboard/secret manager; never put secrets in chat, git, browser storage, or `VITE_` variables. No value was read or changed during this task.

| Canonical variable | Required value/handling |
|---|---|
| `META_APP_ID` | Existing approved Dovroyn Meta app ID; nonsecret. Alias `META_CLIENT_ID` exists. |
| `META_APP_SECRET` | That app's existing secret installed securely by an authorized operator. Alias `META_CLIENT_SECRET` exists. |
| `META_OAUTH_REDIRECT_URI` | `https://dovroyn.com/api/integrations/callback`, exactly matching Meta's registered URI. Alias `META_REDIRECT_URI` exists. |
| `META_GRAPH_VERSION` | `v26.0` is current code default; verify compatibility before enablement. |
| `META_TOKEN_ENCRYPTION_KEY` | Secret exactly 32 bytes encoded as 64 hex characters or base64url; AES-256-GCM. |
| `META_TOKEN_ENCRYPTION_KEY_VERSION` | Nonsecret stable key identifier, 1–64 letters/digits/dot/underscore/hyphen; retain corresponding key securely. |
| `META_OAUTH_COOKIE_SECRET` | Independent high-entropy server secret recommended. Current code falls back to encryption key if omitted. |
| `SUPABASE_SERVICE_ROLE_KEY` | Existing Dovroyn project's service role key, server-only; do not rotate or replace unrelated Stripe configuration. |
| `SUPABASE_URL` | Same Dovroyn project as client authentication. Existing `VITE_SUPABASE_URL` takes precedence in server helpers, so both must agree. |
| `SUPABASE_PUBLISHABLE_KEY` | Existing auth verification fallback; `VITE_SUPABASE_ANON_KEY` takes precedence, then `SUPABASE_ANON_KEY`. These are publishable keys, never service role. |
| `DOVROYN_APP_URL` | `https://dovroyn.com` for callback UI redirect origin; existing `SITE_URL`/Vercel hostname are fallbacks. |
| `META_ORGANIC_CONNECTIONS_ENABLED` | Keep absent/false until database, provider compatibility and authorized smoke-test gates pass. Exact string `true` enables initiation. |

Vercel environment changes require an approved deployment using the intended configuration; permission to install configuration is not permission to merge/deploy. Browser login cookies and provider tokens are not configuration to copy or extract.

## Unresolved Meta compatibility and controlled test

This implementation is **Instagram API with Facebook Login**, for professional Instagram accounts linked to a Facebook Page. It is not the Instagram Login route and does not connect Facebook publishing or Meta Ads. It requests only `instagram_basic` and `pages_show_list`; reads `/me/permissions` and `/me/accounts?fields=id,name,instagram_business_account{id,username,name}`; POSTs both authorization-code and long-lived token exchanges to `/v26.0/oauth/access_token` using form bodies, then uses bearer headers for Graph reads.

Before real enablement, verify the app supports that login product/route and Graph version, the two requested permissions suffice for those exact account fields (including whether `pages_read_engagement` is required), and Meta accepts POST for both token exchange variants. Official get-started and long-lived-token pages returned HTTP 429 again during this review, so these specifics are not claimed verified. Do not add permissions based on assumption.

Authorize a limited app-admin/test-user account-link smoke test with the existing approved Page-linked Instagram account, using a browser operated by the authorized user: owner pod with eligible subscription → official Meta login → exact registered callback → actual account label/ID in authenticated status → encrypted credential stored server-side. Verify denial, state replay and wrong browser fail, no token/secret appears in response/redirect/logs, and another tenant cannot see the connection. No post or ad operation is included. Multiple discovered accounts intentionally fail with ambiguity until an account-selection flow exists.

`pages_manage_posts` remains separately pending and is not requested. The SQL currently rejects storing a token whose granted-scope list includes it; if the test user previously granted that scope, this needs a reviewed scope-handling decision before activation. Development-mode success with an app-role user is not public customer approval; public onboarding needs the applicable Meta review/live-mode process. Do not switch app mode or request broader grants under this checklist alone.

## Exact decision requested

1. Approve the reconciled **dormant source** for parent review, with proposed SQL outside migration discovery and activation disabled; branch reconciliation with any unpushed `feat/first-half-release` work remains separate.
2. Separately approve the Dovroyn database changes above, including all-provider browser-write revocation and legacy Instagram reconnect effects, plus secure installation of the named server configuration.
3. After Meta compatibility is verified, explicitly authorize a controlled account-link test and its required test-environment deployment/enablement. Approve public production activation only after that test passes. Publishing, ads, broader scopes and public app-mode changes require separate decisions.
