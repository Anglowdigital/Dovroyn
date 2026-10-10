# Dovroyn Google Ads conversion review

Reviewed 10 October 2026 UTC / 11 October Perth, default branch commit `8473d278ce6e8b49aa13713d950bd7343e7f8d9c`. PR #40 is merged; subsequent conversion/consent changes are in main. Corrections prepared on `fix/google-ads-signup-measurement`. Live deployment and account configuration were unverified at review time.

## Initial review evidence and verdict (before PR #41)

| Surface | Current main finding | Prepared correction / remaining status |
| --- | --- | --- |
| Google Ads base tag | Loads once; configures AW-18371036038. Four consent signals default denied before config. | Preserved; bootstrap now restores valid saved choice before config. |
| Signup | `/signup-success` emits on any signed-in visit, refresh or session change. No transaction ID. | Only a successful signup response with identities creates a pending marker. Confirmed matching user emits a random conversion-only transaction ID, then clears the marker. Immediate-session and email-confirmation paths use this helper. |
| Purchase | Purchase label is exported but never consumed. Existing checkout flows leave for Stripe Payment Links; no verified payment-return endpoint or purchase event exists. Webhook only updates subscriptions. | Initially missing; see the verified purchase follow-up below. No purchase emitted on Subscribe click, subscription load or an unverified URL. |
| Consent | Banner is app-wide after bootstrapping, but no reopening control; storage exceptions can break rendering; restoration occurs after React starts. | Storage-safe reads/writes; synchronous updates; reopening control; clearer description of the existing advanced-consent behavior. |
| GA4 | No G- measurement ID configuration, GA4 `sign_up`, or GA4 `purchase` event found in the repository. | Analytics/Ads linking does not establish that these events exist. Google tag destination settings or external injected tags need account verification. |
| Live configuration | Vercel connector returned UNAUTHORIZED: reauthentication required. No Google Ads action settings/reporting inspected. | Deployment, labels and actual receipt/attribution remain unverified. |

## Exact configuration dependencies

- Signup: `VITE_GOOGLE_ADS_SIGNUP_LABEL` must contain the **label only** from the intended Google Ads website conversion action for account `AW-18371036038`. Resulting destination: `AW-18371036038/<label>`. Empty/whitespace labels disable emission. It is a public tracking identifier, not a secret.
- Vite embeds VITE variables **at build time**. Verify the value on the actual Dovroyn Vercel project's **Production** environment and any intended Preview environment, then build/deploy the reviewed code. Adding a value after a build does not update that build.
- Signup requires the existing configured Supabase auth, a successful new signup response with identities, a confirmed session, browser `crypto.randomUUID`, and the global `gtag`. Email confirmation must return to `/signup-success` as already requested by the existing signup code; verify its allowlisting in Supabase without changing auth configuration.
- Email confirmation in another browser/device, or after browser storage is cleared/blocked, cannot recover the originating registration marker. These cases are deliberately not counted from an arbitrary signed-in page visit. Cross-device completion would require a separately designed trusted server event; not implemented here.
- Signup retains the pre-existing nominal value `1` and currency `AUD`; this is **not revenue**. Google Ads action value settings must be checked against that choice.
- `VITE_GOOGLE_ADS_PURCHASE_LABEL` is now consumed by `src/lib/purchaseConversion.js`. It requires a distinct intended website purchase conversion action in the same account and the prerequisites below; setting it alone cannot create a purchase conversion.
- Existing checkout destinations: `VITE_STRIPE_{STARTER,GROWTH,PRO,SCALE}_{MONTHLY,YEARLY}`. Each actual Payment Link's return behavior must be inspected in Stripe; it is not defined by this repo.
- A safe purchase path must obtain a real Checkout Session ID from Stripe's configured completion redirect, verify payment server-side (completed and paid; exclude unpaid, cancelled, failed and zero-payment/trial starts), return only necessary amount/currency and unique transaction ID, and emit once for that transaction under the user's consent signals. Handle delayed payment methods explicitly. Do not infer purchases from active subscriptions or fabricate amounts from plan names. Avoid exposing Stripe customer/email/payment data or allowing arbitrary sessions to be enumerated.
- Purchase verification would require server-only `STRIPE_SECRET_KEY` and a securely designed verification endpoint. Existing webhook also requires `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, and `VITE_SUPABASE_URL` or `SUPABASE_URL`. These are existing dependencies, not values modified in this review. Never prefix server secrets with VITE_.

## Consent and account verification

The existing implementation is **advanced consent mode**: the tag loads with denied defaults and may send cookieless signals before acceptance/after decline. Decline does not mean zero network requests. Acceptance grants ad_storage, ad_user_data, ad_personalization and analytics_storage together; the revised banner describes that. Users can reopen Google measurement settings to decline again. This review verifies signal ordering and behavior, not jurisdictional legal compliance or consent evidence retention. No change to basic/tag-blocking mode or granular preferences was assumed.

In Google Ads, verify that each label belongs to the intended action/account, intended count/value settings, inclusion in bidding goals, and conversion diagnostics. If equivalent GA4-imported and direct Ads conversions both exist, review primary/secondary designation to avoid counting the same business outcome twice. In Google tag/Analytics settings verify actual GA4 destinations, key events and imports; linking alone is insufficient.

Use Tag Assistant on the deployed site: fresh browser before choice, accept, reload, reopen/decline, signup confirmation, refresh, revisit while already signed in, failed signup and confirmation in another browser. Confirm one intended conversion and no duplicates, correct send_to, transaction ID and consent state. A `gtag` queue entry is not proof of network delivery or Google Ads attribution. No live signup, payment, campaign or analytics test traffic was sent by this review.

## Additional payment blocker

`api/stripe/webhook.js` calls `admin.auth.admin.getUserByEmail` in both subscription handlers. That method is absent from the installed Supabase Auth SDK (confirmed locally: its type is `undefined`). A matching webhook would reach `handler_failed` at that call. This is a pre-existing payment/subscription provisioning defect, not fixed because this task excludes changes to authentication/Supabase setup. It must be resolved before claiming payment provisioning works; an active subscription alone is still not a purchase conversion.

## Validation

- Baseline reproduction: two signed-in `/signup-success` effect executions enqueue two conversions; corrected visit without a registration marker returns false.
- Focused Google Ads + static SEO checks: **20/20 passed**.
- Full repository suite: **239/239 passed**.
- Production build: **passed**, 1,901 modules.
- `git diff --check`: **passed**.
- Tests exercise event payloads, confirmation gating, marker restoration/deletion, duplicate suppression, wrong users, empty labels, tag failure, storage failure and actual inline bootstrap execution. They do not prove Supabase/Stripe/Google/Vercel live behavior or a rendered-browser journey.
- Pricing, branding, auth calls/redirects and Supabase configuration/schema are preserved. Only measurement hooks were added around existing signup results. No payment flow was changed.

Official references:
- https://developers.google.com/tag-platform/security/guides/consent
- https://developers.google.com/tag-platform/security/concepts/consent-mode
- https://support.google.com/google-ads/answer/6386790
- https://docs.stripe.com/api/checkout/sessions

## Verified purchase follow-up — 11 October 2026 Perth

Code now provides `/purchase-success?session_id={CHECKOUT_SESSION_ID}` and POST `/api/stripe/verify-purchase`. The page uses the existing signed-in Supabase session; the server verifies the existing bearer token, reads the authenticated user's existing RLS-protected subscription row, and retrieves the referenced Checkout Session from Stripe using server-only `STRIPE_SECRET_KEY`. Both the Stripe customer ID and subscription ID must exactly match the server-owned `stripe_customer_id` and `stripe_subscription_id`; no fallback to customer-entered email or client-supplied identity exists.

Only live, complete, paid subscription checkout sessions with positive integer AUD totals can produce a payload. Trial/zero-payment, unpaid, failed/incomplete, test, wrong-customer/subscription and non-AUD sessions are rejected. Actual `amount_total / 100` is measured, including Stripe's actual discounts/taxes, not a guessed plan price. A SHA-256 checkout identifier is used as the stable transaction ID; no Stripe customer ID, subscription ID, email or raw provider error is returned or sent to Google. Repeat effects, refreshes and visits use local suppression plus Google's transaction-ID deduplication. Repeated purchases with distinct Checkout Sessions remain distinct. The return page can retry delayed payments manually; it does not fulfill purchases or update billing access.

**Exact remaining configuration/data dependencies:**

1. Set the intended label-only `VITE_GOOGLE_ADS_PURCHASE_LABEL` for Production and rebuild/redeploy. The empty value remains a no-op.
2. The existing server-only `STRIPE_SECRET_KEY` must belong to the Stripe account that owns the existing Payment Links.
3. Configure each intended existing Payment Link's **after completion** redirect to `https://dovroyn.com/purchase-success?session_id={CHECKOUT_SESSION_ID}`. No Payment Link or price was changed in this review.
4. The existing server-owned subscription row must contain the genuine `stripe_customer_id`, `stripe_subscription_id` and intended paid tier. **The current webhook neither resolves users successfully (`getUserByEmail` is absent) nor populates those two IDs.** Therefore the new verifier safely refuses affected rows until provisioning is separately corrected/verified; no live success is claimed. No schema, RLS policy, auth mechanism or database configuration was changed.
5. Buyers must be signed in to the matching Dovroyn account when returning. A logged-out buyer sees a sign-in instruction and can revisit the confirmation URL after login. Existing auth redirects are unchanged. Old purchases for a replaced subscription and purchases without a matching row are intentionally unverified; this is not a renewal or offline-conversion implementation.
6. Verify the Ads action, consent state, exact value/currency/transaction ID and receipt in Tag Assistant/Google Ads on the actual deployed site. GA4 purchase events/imports remain separate and unimplemented here.

Validation of this follow-up: **251/251 repository tests passed**, **11/11 purchase boundary checks passed**, and production build passed (1,902 modules). Boundary checks cover authentication, ownership, invalid references, missing configuration, unpaid/test/zero-payment sessions, rate limiting, data minimisation, repeat conversions, blocked storage and late completion after unmount. Live Stripe, Vercel labels, customer provisioning and Google Ads receipt remain unverified.

The #41 and #42 merge commits were reported successfully deployed by GitHub's Vercel status on 11 October Perth. That status is build/deployment evidence, not proof of live conversion delivery.
