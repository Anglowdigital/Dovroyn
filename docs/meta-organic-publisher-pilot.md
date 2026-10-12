# Meta Organic Publisher Pilot Foundation

Status: disabled-by-default foundation only. No deployment, live Meta request, secret creation/access, database grant, cron registration, or applied migration is included.

## Scope

This checkpoint adds an injectable publishing-worker foundation for:

- Facebook Page organic image posts.
- Instagram professional account image posts via the Instagram Platform with Facebook Login.

It does not implement ads, universal platform publishing, activated live Graph publishing, or automatic posting.

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
- Actual Graph adapter code is injectable and disabled unless explicitly wired into the inactive scheduler. It uses fixed `graph.facebook.com/{version}`, no redirects, bounded response bodies/deadlines, Page tokens only, and sanitized receipts.
- Facebook Page publishing requires a proven `post_id`; a bare photo id is stored only as `photoId` and is not treated as a published Page post.
- Instagram publishing persists the exact container checkpoint before polling/publishing, and any ambiguous outcome after container creation remains `unknown` with the durable container id.
- Provider mutation stages are lease-fenced and durable; duplicate stage dispatch is rejected instead of retried blindly.
- The scheduler entrypoint is present but inactive by default. It accepts an existing bearer secret from `META_ORGANIC_SCHEDULER_SECRET` or standard `CRON_SECRET`, requires publisher readiness before provider construction, and is not registered in `vercel.json`.

The production storage adapter is intentionally an RPC interface. The proposed SQL in `supabase/proposed-migrations/20261012003000_proposed_meta_organic_publisher_pilot.sql` documents the tables and RPC names, but it is not applied.

## Immutable Artwork Export

`api/_lib/metaOrganicArtworkExport.js` turns an explicitly reviewed creative composition into immutable JPEG bytes and a server-created manifest. The browser HTML preview and legacy metadata-only `creative_review` rows are not enough, because the server renderer has its own fixed layout/font/output contract.

- Inputs are owner, pod, post, provider account, and approval-row bound.
- The current saved `social_posts` caption/body is rechecked against the approval snapshot before rendering.
- `prepareMetaOrganicArtworkReviewEvidence` is the proposed server-side preparation path for real uploads/source images: it reads the actual bytes through injected trusted storage/fetch adapters, records digest plus object version or source revision, renders the exact JPEG candidate, and returns the final rendered-byte hash for renewed review.
- Legacy unpinned approvals fail closed with bounded reasons such as `EXPORT_SOURCE_EVIDENCE_REQUIRED`, `EXPORT_COMPOSITION_REVIEW_REQUIRED`, or `EXPORT_RENDER_REVIEW_REQUIRED`.
- The approved source image must be either the exact pod storage object under `userId/podId/` or the exact reviewed `source_media` URL; missing media produces an explicit typography-only render only when the approval has no image.
- Source images are decoded with bounded byte and pixel limits, cropped or logo-fit according to the frozen composition, composited with brand/headline/CTA only, and emitted as stripped JPEG at `1080x1350`.
- Object names are immutable and bind the approval/account path: `meta-organic-exports/{owner}/{pod}/{post}/{creativeApprovalId}/{accountConnectionId}/{outputHash}.jpg`.
- The manifest hash is separate from the output byte digest and binds owner, pod, post, account connection, provider account id, creative-review approval id, frozen composition, content version/hash, source identity/hash/version, output hash/type/dimensions/size/path, renderer version, and bounded read-only provider URL expiry.
- Persisted target snapshots may carry only provider/provider-account/label; the server resolves the private account connection for the same owner/pod/provider/account and refuses current-default retargeting.
- The later private publishing approval remains a separate account/date authority record. It links to the export through the immutable manifest hash; the exporter never creates publishing approval.
- Export approval is only artwork export authority. It is not publishing permission.

The default renderer uses `sharp`; storage, source fetch, and manifest persistence are injectable for tests. No live storage policy, SQL migration, bucket grant, provider request, or scheduler is introduced. The rendered synthetic inspection sample is `docs/meta-organic-artwork-sample.jpg`.

Run the isolated proposed-SQL verification only when PGlite is available:

```bash
PGLITE_MODULE=/tmp/dovroyn-pr48-sqlcheck/node_modules/@electric-sql/pglite/dist/index.js node docs/meta-organic-publisher-pglite-check.mjs
```

The script fails clearly if `PGLITE_MODULE` is absent. It is intentionally outside `test/` so normal `npm test` stays portable on clean checkouts.

## Remaining Gates

- Applying proposed private schema/RPCs, granting service execution, configuring an existing scheduler bearer secret, and adding any production cron schedule remain approval-gated activation steps.
- Publish permissions must be requested, reviewed, granted, and stored in private Meta connection storage before activation.
- Stored Instagram discovery-era user tokens are not relabelled; publishing requires a page-token credential with publish scopes.
- Provider adapters and read-only reconciliation code remain inactive until reviewed runtime configuration, credentials, scopes, schema, cron registration, deployment, and final approval are complete.


Signed export URLs and their exact expiry are covered by the immutable manifest digest. URL renewal requires a new manifest and explicit publishing approval; silent URL replacement is rejected. Live storage, source-byte preparation and rendered-JPEG review UI, renewal orchestration and real provider adapters remain activation prerequisites.

### Exact publishing-time gate

The explicit queue helper requires a durable approval response containing the exact requested scheduled timestamp. The current proposed approval RPC records campaign dates only, so that helper deliberately returns `PUBLISH_SCHEDULE_APPROVAL_REQUIRED` and does not enqueue. The next calendar publishing-review milestone must add durable exact-time binding and authenticated user confirmation before this path can be enabled. Creative approval alone never supplies publishing consent. Scheduler reconciliation receives the same absolute deadline as publishing and stops claiming at the shorter lease-safe budget.
