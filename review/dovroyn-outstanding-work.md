# Dovroyn outstanding work

Updated 11 October 2026 Perth. This checklist records supported unfinished work; it does not mark API availability, external accounts or deployments complete without live evidence. Jae authorised continuing all previously requested Dovroyn work, including obtaining/integrating provider APIs, provider signups where supported, tier-based publishing/advertising, using Dovroyn's own website in a Pod, and merging/deploying verified changes. Preserve GitHub + Vercel + Supabase; no rebuild, price/brand changes, auth reconfiguration or Supabase setup/schema changes.

## Current work

- [x] Review Google Ads measurement in the existing repo; establish the purchase label is unused.
- [x] Prepare and verify signup duplicate prevention, confirmed-account gating and consent fixes (239 tests and build pass).
- [x] Publish PR #41: https://github.com/Anglowdigital/Dovroyn/pull/41
- [x] Merge PR #41 under existing authorisation.
- [ ] Complete the follow-up layout correction from the PR review (persistent measurement-settings control must be outside document flow).
- [ ] Verify production deployment matches the merged commit. Vercel connector currently requires reauthentication.
- [ ] Verify Production signup label, intended Google Ads action/account and live Tag Assistant behavior. Labels are build-time Vite inputs; see google-ads-conversion-review.md.
- [ ] Verify Stripe Payment Link completion behavior and implement a trusted payment-completion path before enabling purchase conversions. Never count clicks or active subscriptions as payment evidence.

## Wider authorised launch work

| Work | Evidence now | Next dependency / useful step |
| --- | --- | --- |
| Dovroyn's own website Pod | NewPod accepts a primary website URL and one logo; server analysis is an authenticated existing path. No live account or failed request was inspected. | Reproduce in the existing account with actual Pod/source/logo and inspect its failed response. Verify OPENAI_API_KEY/model availability and current production deployment through Vercel. Do not create a replacement app or alter source locks/auth to hide a failure. |
| Provider API connections | All catalogue entries have provider-setup-required status. Social connect modal says not live. No provider OAuth/callback/token storage/publishing endpoints found. | Obtain actual provider app IDs, approved permissions and redirect URLs for intended services; use official authorisation. Confirm existing encrypted server token storage before connecting; no tokens in public Pod rows/browser bundles. Preserve the no-Supabase-setup-change constraint. |
| Live publishing / scheduling | Existing content API generates paid, direction-approved drafts; no actual provider publisher/scheduler found. | Implement against verified connected providers and trusted account targets, paid-period enforcement, idempotency and human approval. Existing platform planning support must not be represented as live publishing. |
| Tier-based advertising | Canonical paid limits are implemented. No confirmed platform connection quota exists. Ads/spend are currently plan-only; no live execution route found. | Preserve Starter/Growth/Pro/Scale prices and allowances. Use explicit approved campaign/budget authority; do not launch ads or change spend from a saved plan or generic permission to build the app. |
| API/provider costs | No approved purchasing cap, selected paid provider service, or billable signup requirement was recovered. | Use existing/free authorised access where supported. Surface exact unavoidable paid costs from official current terms before committing to a paid service. Do not purchase every platform in the recommendation catalogue. |
| Stripe provisioning | Existing webhook invokes getUserByEmail, absent from installed Supabase SDK. | Review/remediate separately with focused verification under auth/setup constraints; do not call live provisioning working while this code path is broken. |

## Provider inventory

The catalogue's named services are evidence of **planning recommendations**, not proof Jae selected every one for an account signup: Instagram, Facebook, TikTok, YouTube/Shorts, LinkedIn, X, Threads, Pinterest, Snapchat, Reddit, WhatsApp, Telegram, Discord, WeChat, LINE, Tumblr, Mastodon, Bluesky, Twitch, Spotify, Apple Podcasts, Substack, Medium, Google Business Profile, Nextdoor, Google Ads, Meta Ads, LinkedIn Ads, TikTok Ads, Pinterest Ads, Amazon Ads, Microsoft Ads, Email, SMS and Website Blog. Resolve any exact named providers from the earlier task record before consequential signups; do independent code work while access is unavailable.

## Progress rules

Read current main/PR state and existing notes before repeating work. A completed code test does not prove live configuration or provider delivery. Mark a task done only with direct evidence; record exact access, external approval or paid-service blockers. Do not expose build notes or this checklist in customer-facing UI. Alert Jae only for concrete progress or a new blocker requiring her action; do not repeat unchanged access requests.
