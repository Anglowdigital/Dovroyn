# Creative draft persistence verification

Baseline: `e875baf5317a1c6853753be1a3419766d5c96477` (PR #58).

The creative editor now offers **Save creative draft** independently of Meta readiness. It writes an active `creative_review` revision through the existing authenticated `pod_preferences` insert path. Existing owner RLS scopes access to the pod. No new schema, migration, local-storage fallback, API endpoint or configuration is required.

The saved payload contains headline, CTA, stable upload/source image reference, composition and caption snapshot with `status: draft` and `approved_at: null`. The response must confirm row identity, pod, type, active state, creation time and the complete payload before reporting success. Failed or mismatched writes stay unsaved. Caption saving remains its existing separate action.

A new draft supersedes prior creative approval without mutating approved artwork or immutable calendar snapshots. Existing calendar attachment logic requires the latest revision to be approved; existing export/review/publishing checks remain unchanged. No account targets, tier allowances, schedules, permissions or live posts are changed.

Same-client saves are serialized per pod/post across editor remounts. Late responses reconcile parent preferences only in their captured pod lifecycle; they cannot mark changed editor content saved or leak into another pod. An editor returned to before a save completes restores the confirmed draft if it has no newer local edits. This is ordinary latest-revision persistence, not a new cross-browser collaborative-editing protocol.

Latest review selection now matches server `created_at DESC, id DESC`, including PostgreSQL sub-millisecond timestamp precision. Memoization keeps JSON-string preferences stable during exact-render review.

## Checks

- `npm test`: **437 passed, 0 failed**.
- `npm run build`: passed; existing large bundle warning remains.
- `node review/draft-persistence-browser.mjs` with Playwright/Chromium: passed at 1440×900 and 390×900 using explicitly labelled controlled HTTP fixtures and the real Supabase query builder. Verified save, tab navigation, browser reload after clearing local/session storage, image/headline/CTA restoration, delayed same-pod remount, cross-pod late completion and independent saves. Zero Meta/publishing API calls.
- Existing `review/draft-preview-browser.mjs`: passed desktop/mobile disconnected editing and connected simulated exact-JPEG approval/invalidation.
- Unit coverage: stable source/upload references; typography; malformed response and RLS-denial handling; same-post request ordering; stale caption save; late unmount reconciliation; foreign/old-pod lifecycle rejection; clean remount versus newer local edits; approved calendar attachment supersession while old snapshots stay immutable; timestamp ties/precision; JSON-string restored draft preparation.
- Independent review found a delayed tab-navigation reconciliation issue; it was fixed and regression-tested. Final independent review found no remaining blockers (99 relevant tests, then 24 editor tests including the final memoization regression passed independently).
- Desktop/mobile screenshots inspected against prior preview behavior. Evidence under `/tmp/dovroyn-draft-browser` and `/tmp/dovroyn-draft-*.log`.

These are controlled fixtures and repository security checks, not authenticated owner-account acceptance or verification of proposed Meta database migrations in production. No migration, credential, permission, scheduler, live-posting or paid-generation operations occurred.
