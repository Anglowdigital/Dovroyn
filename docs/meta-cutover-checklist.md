# PR50: Meta organic account-selection cutover

Inputs: dormant PR50 base `af2d319323ddc8dc3ed4940de57e252762c36068`, reconciled PR48/PR49 source, and the proposed SQL in `supabase/proposed-migrations/20261012000000_proposed_meta_organic_connection_cutover.sql`. This file is a review checklist only. No production migration, secret, grant, account setting, merge, or deployment was performed.

## Dormant Source

The integrated source remains dormant unless `META_ORGANIC_CONNECTIONS_ENABLED` is exactly `true` and the readiness RPC reports contract `meta_organic_facebook_login_selection_v2`. The previous PR48 contract `meta_organic_facebook_login_v1` is intentionally rejected because it lacks the account-selection storage/RPC protocol.

Connect, callback, selection GET/POST, and status fail closed when the activation gate or storage contract is unavailable. Status uses the server RPC `list_meta_organic_connections`; it does not trust browser-writable legacy `social_connections` rows as provider-verified Meta status.

## Official Meta Docs Verified

Retrieved HTTP 200 on 2026-10-12 from local captures supplied by the coordinator:

- `https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/` documents server-side `GET /v26.0/oauth/access_token` for authorization-code exchange. Code and long-lived token exchange use documented GET, trusted `graph.facebook.com`, redirects disabled, and sanitized errors.
- `https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram` documents `GET /me/accounts` with `id,name,access_token,instagram_business_account` and says users may need to choose by Page name when multiple Pages exist.
- `https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started` documents the base Instagram discovery path as `GET /me/accounts` to list Pages, then `GET /{page-id}?fields=instagram_business_account` with the user token to identify the linked IG User ID.
- `https://developers.facebook.com/docs/graph-api/reference/user/accounts/` confirms Page nodes/tasks on the accounts edge. No publishing, messaging, ads, or `pages_manage_posts` permission is included.
- `https://developers.facebook.com/docs/instagram-api/reference/ig-user/` was also reported HTTP 200 and lists `pages_read_engagement` for IG profile-read fields such as username/name. This implementation does not request that scope and therefore does not request IG profile fields during discovery.

Scope behavior is split by requested provider: Facebook Page-only requests and validates `pages_show_list`; Instagram requests and validates `instagram_basic,pages_show_list`. Previously granted unrelated permissions are tolerated but filtered out before pending selection storage and final connection storage.
Instagram identity choices are labelled from the linked Facebook Page name plus the IG ID returned by the documented `/{page-id}?fields=instagram_business_account` lookup; they are not profile usernames.

## Proposed Database Approval

Approve a single transactional cutover in the Dovroyn Supabase project, executed by the trusted migration owner. Do not run it through an end-user token.

The proposal creates a new Meta-only private trust path:

| Object | Recipient | Change |
|---|---|---|
| `private.meta_organic_oauth_states` | `PUBLIC`, `anon`, `authenticated` | Revoke all table privileges; enable RLS with no client policy. |
| `private.meta_organic_pending_selections` | `PUBLIC`, `anon`, `authenticated` | Revoke all table privileges; enable RLS with no client policy. |
| `private.meta_organic_connections` | `PUBLIC`, `anon`, `authenticated` | Revoke all table privileges; enable RLS with no client policy. |
| `private.meta_organic_credentials` | `PUBLIC`, `anon`, `authenticated` | Revoke all table privileges; enable RLS with no client policy. |
| public Meta RPCs | `PUBLIC`, `anon`, `authenticated` | Revoke execute. |
| public Meta RPCs | `service_role` | Grant execute only. |

It deliberately preserves existing `private` schema ACL, `public.social_connections` browser grants, unrelated private tables, shared connection rows, and old private credentials. Legacy Meta rows in `social_connections` are preserved as data but are not trusted by the new Meta status API; users must reconnect through the new server flow for provider-verified Meta status.

RPCs are `SECURITY DEFINER` with empty `search_path`:

1. `get_meta_organic_connection_readiness()` verifies v2 contract, private tables, service execute permissions, and browser denial on new Meta tables/RPCs.
2. `create_meta_organic_oauth_state(text,text,uuid,uuid,text,text,text[],timestamptz)` stores hashed state plus browser binding, requested provider, required scopes, owner pod, redirect, and expiry.
3. `consume_meta_organic_oauth_state(text,text)` atomically consumes callback state and returns trusted pod/provider/scope context.
4. `create_meta_organic_pending_selection(...)` stores encrypted user token and encrypted candidate data for a short TTL.
5. `get_meta_organic_pending_selection(text,uuid,uuid)` returns only encrypted server-side pending data to the server.
6. `commit_meta_organic_account_selection(text,uuid,uuid,jsonb,jsonb)` rechecks owner/expiry under row lock and atomically stores selected Facebook Page and/or Instagram connection, then consumes pending selection.
7. `list_meta_organic_connections(uuid,uuid)` returns trusted status metadata without credentials.

Actual isolated SQL evidence: `/tmp/dovroyn-meta-selection-sql-check.mjs` passed 16/16 in PGlite 0.5.8 against a synthetic schema, including unrelated ACL/data preservation, pending ownership, Page token kind, atomic both-write, failed second-write rollback preserving selection, retry/replay, expiry, private RLS/RPC denial, and credential exclusion from status. This is not proof of production Supabase state.

## Runtime Configuration Approval

Install values only in the Dovroyn Vercel project/environment selected for the approved test. Do not put secrets in chat, git, browser storage, or `VITE_` variables.

Required variables: `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI`, `META_GRAPH_VERSION` if overriding `v26.0`, `META_TOKEN_ENCRYPTION_KEY`, `META_TOKEN_ENCRYPTION_KEY_VERSION`, `META_OAUTH_COOKIE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, Supabase URL/publishable key values matching the client auth project, `DOVROYN_APP_URL`, and finally `META_ORGANIC_CONNECTIONS_ENABLED=true` only after database and deployment approval.

## Controlled Test

Authorize a limited app-admin/test-user account-link smoke test only after code review, migration approval, environment approval, and deployment approval: owner pod with eligible subscription -> official Meta login -> exact registered callback -> explicit Page/IG selection -> authenticated status shows selected labels -> no token or secret appears in response/redirect/logs -> another tenant cannot read it. No post, ad, messaging, or publishing operation is included.

`pages_manage_posts` remains separately pending and is not requested. Public onboarding still requires the relevant Meta review/live-mode process; do not switch app mode or request broader grants under this checklist.
