# Dovroyn outstanding work

Updated 11 October 2026 Perth. This checklist records supported unfinished work; it does not mark API availability, external accounts or deployments complete without live evidence. Jae authorised continuing all previously requested Dovroyn work, including obtaining/integrating provider APIs, provider signups where supported, tier-based publishing/advertising, using Dovroyn's own website in a Pod, and merging/deploying verified changes. Preserve GitHub + Vercel + Supabase; no rebuild, price/brand changes, auth reconfiguration or Supabase setup/schema changes.

## Current work

- [x] Review Google Ads measurement in the existing repo; establish the purchase label is unused.
- [x] Prepare and verify signup duplicate prevention, confirmed-account gating and consent fixes (239 tests and build pass).
- [x] Publish PR #41: https://github.com/Anglowdigital/Dovroyn/pull/41
- [x] Merge PR #41 under existing authorisation.
- [x] Merge the fixed-position measurement-settings correction in PR #42; 240 tests and build passed.
- [x] Verify GitHub reports Vercel deployment success for #41 and #42 merge commits (latest #42: 55427cec7674609d6011d87a947b94ff8606be19). Direct Vercel settings still require reauthentication.
- [ ] Verify Production signup label, intended Google Ads action/account and live Tag Assistant behavior. Labels are build-time Vite inputs; see google-ads-conversion-review.md.
- [x] Implement and locally verify the trusted purchase-completion route and endpoint (253 tests and build pass), using existing RLS and server-owned Stripe IDs.
- [x] Merge PR #43 after correcting its logged-out return-reference review finding; GitHub reports Vercel deployment success for merge commit `4620c5fe0e7a83f5e0d06904ca28035903341fe6`.
- [x] Prepare and locally verify the existing Stripe webhook provisioning correction: require an existing signed-in Dovroyn account on every paid checkout surface, use supported Supabase lookup with local multi-digit pagination, verify exact raw request bytes, persist existing Stripe IDs, and reconcile subscription-ID-guarded writes with deterministic same-second ordering so stale or overlapping checkout/update/delete events cannot replace or lose the selected subscription (265 tests and build pass).
- [x] Merge PR #44 after all seven current-head review findings were corrected; 265 tests and the production build passed. GitHub reports Vercel deployment success for merge commit `9b8269f616335b5f55d0b82cdb5ed9457b7d2175`.
- [ ] Verify/configure intended Stripe Payment Link completion redirects, purchase label and real subscription IDs before claiming live purchase recording. Never count clicks or active subscriptions as payment evidence.
- [x] Add a review-before-create Dovroyn website Pod preset using `https://dovroyn.com` and the existing approved bundled logo; no live Pod is claimed until it is created and analysed in the existing account.
- [x] Merge PR #45 after correcting both logo-loading review findings; 266 tests and the production build passed. GitHub reports Vercel deployment success for merge commit `171e614c096a42bf1b3bd759fa69b7df0e6aceab`.
- [x] Prepare a fail-closed provider execution boundary that separates client-requested action data from server-confirmed state and requires a recognized current paid subscription plus an explicit action entitlement before any future external execution can be allowed.
- [ ] Review, merge and deploy the provider execution boundary after its exact-head checks and material reviews pass. This does not activate a provider or establish any tier-specific provider quota.

## Wider authorised launch work

| Work | Evidence now | Next dependency / useful step |
| --- | --- | --- |
| Dovroyn's own website Pod | PR #45 is merged and GitHub reports its main deployment successful. The review-before-create preset uses `https://dovroyn.com` and the existing bundled approved logo; server analysis remains the authenticated existing path. | Create and analyse it in the existing account. Verify the resulting saved source/assets and any real response; do not claim a live Pod from repository support alone. |
| Provider API connections | All catalogue entries have provider-setup-required status. Social connect modal says not live. No provider OAuth/callback/token storage/publishing endpoints found. The prepared execution boundary fails closed unless trusted server state confirms human approval, an active connection, a trusted target, a current recognized paid subscription and explicit action entitlement. | Merge/deploy the boundary. Obtain actual provider app IDs, approved permissions and redirect URLs for intended services; use official authorisation. Confirm existing encrypted server token storage before connecting; no tokens in public Pod rows/browser bundles. Preserve the no-Supabase-setup-change constraint. |
| Live publishing / scheduling | Existing content API generates paid, direction-approved drafts; no actual provider publisher/scheduler found. | Implement against verified connected providers and trusted account targets, paid-period enforcement, idempotency and human approval. Existing platform planning support must not be represented as live publishing. |
| Tier-based advertising | Canonical paid limits are implemented. No confirmed platform connection quota exists. Ads/spend are currently plan-only; no live execution route found. The prepared external-action guard requires current paid access and a separate server-confirmed action entitlement, so a browser request cannot self-assert access. | Preserve Starter/Growth/Pro/Scale prices and allowances. Define provider-specific entitlements only from an approved product policy and actual provider capabilities; do not launch ads or change spend from a saved plan or generic permission to build the app. |
| API/provider costs | No approved purchasing cap, selected paid provider service, or billable signup requirement was recovered. | Use existing/free authorised access where supported. Surface exact unavoidable paid costs from official current terms before committing to a paid service. Do not purchase every platform in the recommendation catalogue. |
| Stripe provisioning | PR #44 merged and GitHub reports its main deployment successful. The correction requires the existing signed-in session before exposing paid links, replaces the absent SDK method with supported paginated `listUsers`, verifies exact raw bytes, writes existing Stripe ID columns and safely reconciles overlapping subscriptions. No schema, RLS, auth configuration, price or destination changes. | Verify the existing webhook endpoint/events and server-only secrets, then replay/reconcile earlier affected subscriptions. Email matching remains the current Payment Link ownership bridge and must be verified against the signed-in Dovroyn account; do not call live provisioning working without an actual webhook test. |

## Provider inventory

The catalogue's named services are evidence of **planning recommendations**, not proof Jae selected every one for an account signup: Instagram, Facebook, TikTok, YouTube/Shorts, LinkedIn, X, Threads, Pinterest, Snapchat, Reddit, WhatsApp, Telegram, Discord, WeChat, LINE, Tumblr, Mastodon, Bluesky, Twitch, Spotify, Apple Podcasts, Substack, Medium, Google Business Profile, Nextdoor, Google Ads, Meta Ads, LinkedIn Ads, TikTok Ads, Pinterest Ads, Amazon Ads, Microsoft Ads, Email, SMS and Website Blog. Resolve any exact named providers from the earlier task record before consequential signups; do independent code work while access is unavailable.

## Progress rules

Read current main/PR state and existing notes before repeating work. A completed code test does not prove live configuration or provider delivery. Mark a task done only with direct evidence; record exact access, external approval or paid-service blockers. Do not expose build notes or this checklist in customer-facing UI. Alert Jae only for concrete progress or a new blocker requiring her action; do not repeat unchanged access requests.
