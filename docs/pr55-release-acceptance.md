# PR55 Release Acceptance Notes

Status: local acceptance branch only. No push, merge, deployment, live provider request, live storage mutation, migration, grant, secret, scheduler activation, spend, or posting is part of this checkpoint.

## Dormant-Safe Slices

These slices are code-complete enough for review while remaining inactive without explicit runtime and SQL activation:

- URL-first pod intake with optional single logo: website/social/shopify pods require one primary URL, photos-only pods require brand photos, and one logo may accompany either path.
- Source-first AI analysis: the analysis route loads the saved owned pod source, fetches website intelligence before model generation, labels all website/image/user-note evidence, then locks the source only through the server finalization path.
- Dormant Meta connection and account selection: the browser receives only connection/status metadata and labels; credentials stay private and the cutover remains gated by config plus readiness RPC.
- Immutable artwork review/export: server-rendered JPEG evidence, source byte digests, immutable manifests, and per-account export identity are separated from publishing permission.
- Provider/scheduler foundation: real Meta Graph adapters and scheduler entrypoint exist, but the scheduler is disabled by default and readiness/authorization fail closed before provider construction.
- Calendar publishing review: explicit per-account, per-date, exact-time approval is separate from creative approval. The proposed confirm RPC atomically rechecks the whole reviewed day, persists approvals, and enqueues all accounts or rolls back.

## Activation Dependencies

These remain approval-gated and intentionally absent from this branch:

- Applying proposed SQL migrations/RPCs and corresponding service-only grants.
- Confirming production Supabase schema compatibility and migration order.
- Existing approved Meta publish scopes, tokens, and key-versioned private credentials.
- Existing configured scheduler bearer secret, cron registration, deployment approval, and scheduler enable flag.
- Live storage/provider-read URL availability across the dispatch window.
- Live Graph posting, spend, OAuth scope additions, public app-mode changes, or cancelled Meta migration retry.

## Acceptance Coverage Added

- `test/releaseAcceptance.test.js` checks URL-only/optional-logo intake, source-first analysis ordering, missing source URL rejection, multi-account exact-image calendar approval, stale edit rejection before queueing, and scheduler dormant behavior before storage/provider access.
- `docs/meta-organic-postgres-concurrency-check.mjs` is a true PostgreSQL harness for Root-provisioned disposable local runtimes. It reads `/tmp/dovroyn-pg-acceptance-runtime/runtime.json` by default, creates only `dovroyn_acceptance`, applies proposed SQL/fixtures only in that database, uses separate `psql` sessions, and drops the database after the run unless `POSTGRES_ACCEPTANCE_KEEP_DB=true`.
- Root ran an isolated Linux Playwright Chromium 156 browser acceptance harness outside the repo at `/tmp/dovroyn-browser-acceptance-runtime`. Reported passing scenarios covered URL-only intake without logo/no premature AI, optional logo upload, explicit Analyse and lock-pod review, two Facebook accounts saved for one pod, and exact caption/account/`2026-10-12T12:00:00Z` review display in an Australia/Sydney browser where every image had to load, double confirm sent one request, and both account results queued.
- Browser evidence paths reported by Root: `/tmp/dovroyn-browser-acceptance-runtime/results.json`, `acceptance.cjs`, `trace.zip`, and `exact-calendar-review.png`. Those fixtures control API/repository/auth/model/provider outputs and are not live backend/provider E2E.

## Known Limits

- PGlite verifies SQL contract shape, rollback, ACL, and deterministic single-connection behavior only.
- The local PostgreSQL harness validates multi-session locking/claim behavior against extracted PostgreSQL packages and proposed SQL in a disposable test database; it is still not a production Supabase migration, grant, credential, or live-data test.
- Repo UI tests remain component/state-harness tests. Root's separate Linux Playwright Chromium browser acceptance passed controlled fixtures; the Windows CUA launcher remains broken with `0x80070003` and was not repaired here.
