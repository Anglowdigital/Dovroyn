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
- [x] Prepare and locally verify the existing Stripe webhook provisioning correction: require an existing signed-in Dovroyn account on every paid checkout surface, use supported Supabase lookup with local multi-digit pagination, verify exact raw request bytes, persist existing Stripe IDs, and use subscription-ID-guarded writes so stale or overlapping checkout/update/delete events cannot replace the current subscription (263 tests and build pass).
- [ ] Review, merge and deploy the webhook correction after its current-head checks and material reviews pass.
- [ ] Verify/configure intended Stripe Payment Link completion redirects, purchase label and real subscription IDs before claiming live purchase recording. Never count clicks or active subscriptions as payment evidence.

## Wider authorised launch work

| Work | Evidence now | Next dependency / useful step |
| --- | --- | --- |
| Dovroyn's own website Pod | NewPod accepts a primary website URL and one logo; server analysis is an authenticated existing path. No live account or failed request was inspected. | Reproduce in the existing account with actual Pod/source/logo and inspect its failed response. Verify OPENAI_API_KEY/model availability and current production deployment through Vercel. Do not create a replacement app or alter source locks/auth to hide a failure. |
| Provider API connections | All catalogue entries have provider-setup-required status. Social connect modal says not live. No provider OAuth/callback/token storage/publishing endpoints found. | Obtain actual provider app IDs, approved permissions and redirect URLs for intended services; use official authorisation. Confirm existing encrypted server token storage before connecting; no tokens in public Pod rows/browser bundles. Preserve the no-Supabase-setup-change constraint. |
| Live publishing / scheduling | Existing content API generates paid, direction-approved drafts; no actual provider publisher/scheduler found. | Implement against verified connected providers and trusted account targets, paid-period enforcement, idempotency and human approval. Existing platform planning support must not be represented as live publishing. |
| Tier-based advertising | Canonical paid limits are implemented. No confirmed platform connection quota exists. Ads/spend are currently plan-only; no live execution route found. | Preserve Starter/Growth/Pro/Scale prices and allowances. Use explicit approved campaign/budget authority; do not launch ads or change spend from a saved plan or generic permission to build the app. |
| API/provider costs | No approved purchasing cap, selected paid provider service, or billable signup requirement was recovered. | Use existing/free authorised access where supported. Surface exact unavoidable paid costs from official current terms before committing to a paid service. Do not purchase every platform in the recommendation catalogue. |
| Stripe provisioning | The repository correction requires the existing signed-in session before exposing paid links, replaces the absent SDK method with supported paginated `listUsers`, verifies the exact raw request bytes and writes the existing `stripe_customer_id`/`stripe_subscription_id` columns. No schema, RLS, auth configuration, price or destination changes. | Merge/deploy after review. Then verify the existing webhook endpoint/events and server-only secrets, and replay/reconcile earlier affected subscriptions. Email matching remains the current Payment Link ownership bridge and must be verified against the signed-in Dovroyn account; do not call live provisioning working without an actual webhook test. |

## Provider inventory

The catalogue's named services are evidence of **planning recommendations**, not proof Jae selected every one for an account signup: Instagram, Facebook, TikTok, YouTube/Shorts, LinkedIn, X, Threads, Pinterest, Snapchat, Reddit, WhatsApp, Telegram, Discord, WeChat, LINE, Tumblr, Mastodon, Bluesky, Twitch, Spotify, Apple Podcasts, Substack, Medium, Google Business Profile, Nextdoor, Google Ads, Meta Ads, LinkedIn Ads, TikTok Ads, Pinterest Ads, Amazon Ads, Microsoft Ads, Email, SMS and Website Blog. Resolve any exact named providers from the earlier task record before consequential signups; do independent code work while access is unavailable.

## Progress rules

Read current main/PR state and existing notes before repeating work. A completed code test does not prove live configuration or provider delivery. Mark a task done only with direct evidence; record exact access, external approval or paid-service blockers. Do not expose build notes or this checklist in customer-facing UI. Alert Jae only for concrete progress or a new blocker requiring her action; do not repeat unchanged access requests.
