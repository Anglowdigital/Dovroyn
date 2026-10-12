# Meta Organic Publisher Pilot Foundation

Status: disabled-by-default foundation only. No scheduler, deployment, live Meta request, secret access, database grant, or applied migration is included.

## Scope

This checkpoint adds a mocked/injectable publishing-worker foundation for:

- Facebook Page organic image posts.
- Instagram professional account image posts via the Instagram Platform with Facebook Login.

It does not implement ads, universal platform publishing, live Graph publishing, or automatic posting.

## Official Contract Notes

The local references retrieved on 2026-10-12 say:

- Facebook Page publishing uses Page endpoints such as `/{page_id}/feed` or `/{page_id}/photos`, and requires a Page access token plus publish-capable Page permissions including `pages_manage_posts`.
- Instagram content publishing with Facebook Login uses `graph.facebook.com`, a Facebook Page access token, `/{IG_ID}/media`, `/{IG_ID}/media_publish`, and permissions including `instagram_basic`, `instagram_content_publish`, and `pages_read_engagement`.
- Instagram media must be hosted on a public server at publish time, and JPEG is the supported image format for the bounded image pilot.

The current discovery/selection foundation deliberately requests only read/selection scopes (`instagram_basic`, `pages_show_list`) and stores the Instagram selection against the existing private Facebook Login connection contract. That is not enough for publishing, so this foundation rejects such connections with `PUBLISH_TOKEN_CONTRACT_REQUIRED` or `PUBLISH_PERMISSION_REQUIRED` instead of guessing.

## Worker Contract

`api/_lib/metaOrganicPublisher.js` defines:

- `META_ORGANIC_PUBLISHER_ENABLED`, default `false`.
- Exact dedupe key across draft, account connection, content version, asset manifest hash, and campaign date.
- Immutable delivery identity across draft, account connection, content version, asset manifest hash, and campaign date. `approvalId` remains bound evidence on the job, but re-approval of the same delivery tuple cannot create a second deliverable.
- Atomic claim/lease storage interface.
- Human approval binding to pod owner, draft, content version, approved immutable export, account, and date.
- Active paid tier and distinct campaign-date gate, with same-campaign-date multi-account posting allowed.
- Bounded retry/backoff for known safe failures.
- Final `unknown` state for ambiguous provider outcomes, which never re-enters automatic publish retries.
- Injected read-only reconciliation foundation: a trusted mocked lookup can fence `unknown` to a reconciled/published receipt only when provider, account, and immutable delivery identity match exactly. Inconclusive, not-found, mismatched, or lookup-error outcomes remain `unknown`.
- Per-account provider receipts.

The production storage adapter is intentionally an RPC interface. The proposed SQL in `supabase/proposed-migrations/20261012003000_proposed_meta_organic_publisher_pilot.sql` documents the tables and RPC names, but it is not applied.

Run the isolated proposed-SQL verification only when PGlite is available:

```bash
PGLITE_MODULE=/tmp/dovroyn-pr48-sqlcheck/node_modules/@electric-sql/pglite/dist/index.js node docs/meta-organic-publisher-pglite-check.mjs
```

The script fails clearly if `PGLITE_MODULE` is absent. It is intentionally outside `test/` so normal `npm test` stays portable on clean checkouts.

## Remaining Gates

- A real immutable renderer/storage export pipeline must produce a validated manifest hash and provider-readable HTTPS URL. HTML previews and `creative_note` metadata are not publishable assets.
- Publish permissions must be requested, reviewed, granted, and stored in private Meta connection storage before activation.
- Token-kind handling must be upgraded to use Page access tokens for both Facebook Page publishing and Instagram-with-Facebook-Login publishing.
- A live provider reconciliation adapter is still blocked; the current path is injected/mocked only and makes no Graph requests.
- The release flag and scheduler registration must happen in a separate reviewed change.
