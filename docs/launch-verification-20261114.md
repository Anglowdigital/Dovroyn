# Dovroyn launch verification — 14 November 2026

Scope: confirm homepage/demo consistency, match app prices to live Stripe, prove authenticated AI content generation, and verify payment-to-pod activation. Dates in this note use Australia/Perth.

## Confirmed evidence

| Item | Verified result |
| --- | --- |
| Production baseline | GitHub `main` and the inspected live deployment used `ba8039ca7a66c1b9a18cac7f3dd243ef9e1ec2d3`. |
| Public demo | `/` and `/demo-pod` render the same `PodWorkspace demo` component and Aurora Botanicals data. Both initially select **Website & photos**. The Gidgee `TesterPodPreview` file is unused legacy code. |
| Live Stripe prices | All eight base recurring prices were checked against live Stripe checkout. Amounts are listed below. |
| Stripe server configuration | The inspected production runtime returned HTTP **500** with `stripe_not_configured`; the required Stripe server secrets were absent. Public payment links alone do not establish account activation. |
| OpenAI configuration | An OpenAI API key is present in production configuration. Successful authenticated content generation, available provider usage capacity, and output persistence still require a real smoke test. |
| Payment activation | Successful payment-to-pod activation still requires a controlled end-to-end check. Local tests do not establish live activation. |

### Verified AUD base prices

| Plan | Monthly | Yearly | Pod allowance |
| --- | ---: | ---: | ---: |
| Starter Pod | A$89 | A$855 | 1 |
| Growth Pods | A$249 | A$2,390 | 3 |
| Pro Marketing Pods | A$599 | A$5,750 | 7 |
| Scale / Agency Pods | A$1,299 | A$12,470 | 12 |

These are base subscription amounts. Checkout determines any applicable tax or discount. Price comparison must include currency and recurring interval.

## Completed code checks

- Provider quota/billing-limit errors are distinguished from temporary rate limits in analysis, pod chat and content generation. Private provider error details are kept out of client responses. Failed content generation retains the existing allowance-release behavior.
- Website text and image readers now wait for HTTP/pipeline completion before accepting decoder EOF. Encoded and decoded size limits, timeout, cancellation and public-address checks remain enforced.
- Four date-sensitive calendar tests now use a scoped October fixture clock. Production calendar behavior is unchanged.
- The source transport tests pass, including the three original compressed-size failures and focused incomplete-response regressions.
- The final integrated run passed **525 tests**, with zero failures. `npm run build` succeeds; the existing Vite bundle-size warning remains.
- All public plan prices use the shared AUD catalogue. The authenticated checkout validates the configured Stripe price, binds payment to the signed-in account, prevents duplicate payable sessions, and refuses checkout without activation configuration.
- Legacy payment events are limited to configured Dovroyn links and known subscription/customer identities. Both older and modern single-item Stripe billing periods are covered.
- Independent code review reproduced the concurrent-checkout defect before its fix and confirmed one payable session afterwards.

The present evidence indicates app configuration and live verification work. It does not indicate a need to buy ChatGPT Enterprise.

## Configure Stripe secrets without sharing them in chat

Use the Stripe and Vercel dashboards directly. Keep values out of chat, screenshots, source files and command output.

1. Open the correct Stripe account in **live mode**. Obtain the existing server API key from its secure storage or the [Stripe API keys page](https://dashboard.stripe.com/apikeys). The server key must belong to the same account/mode as the verified payment links.
2. In Vercel, open **Dovroyn → Environment Variables**. Add or update `STRIPE_SECRET_KEY` with type **Secret**, scoped to **Production**. Paste the value directly into Vercel. Do not add a `VITE_` prefix.
3. In Stripe **Workbench → Webhooks**, inspect the existing destination for `https://dovroyn.com/api/stripe/webhook`; create it only if absent. Use **Your account** and **Snapshot** payloads because this handler consumes `event.data.object`. Subscribe to:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy that exact destination's signing secret directly into Vercel as `STRIPE_WEBHOOK_SECRET`, type **Secret**, scoped to **Production**. A webhook signing secret is separate from the API key. Test/sandbox and live endpoints have separate credentials.
5. Confirm the existing server-only `SUPABASE_SERVICE_ROLE_KEY` is configured for webhook provisioning. Keep Supabase administrative credentials out of browser-prefixed variables.
6. Deploy/redeploy after saving the variables. Environment changes apply to **new deployments**, not an already running deployment. Use paired sandbox credentials for sandbox payment tests; keep their webhook destination separate from live provisioning.

Current official references: [Stripe key types and modes](https://docs.stripe.com/keys), [Stripe webhook destination setup and signing secrets](https://docs.stripe.com/webhooks), [Vercel Config/Secret variable types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types), and [Vercel environment-variable deployment behavior](https://vercel.com/docs/environment-variables/managing-environment-variables).

### Webhook compatibility

Record the destination's API version when configuring it. Stripe moved subscription billing periods from the subscription object to individual subscription items in `2025-03-31.basil`. The billing handler supports the existing top-level shape and the modern single-item shape; local regression tests cover both. Live delivery still needs verification. See [Stripe's period-field change](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).

No database schema migration is planned for these launch fixes. Existing subscription tables and content-allowance RPCs remain prerequisites; local mocks do not prove their production behavior.

## Remaining live acceptance checks

- [ ] Deploy the final reviewed commit to Vercel Preview; check public routes, demo tabs, signup/login and all eight displayed prices. Vite's local preview alone does not exercise the deployed `/api` functions.
- [ ] Verify authenticated checkout rejects an unknown plan, currency/amount/interval mismatch, or unavailable Stripe configuration. Confirm a valid checkout is bound to the signed-in Dovroyn user.
- [ ] Complete the isolated payment test and verify the signed webhook persists the correct customer/subscription identity, tier, active paid period and pod allowance. HTTP 200 alone is insufficient: inspect whether the event was actually provisioned or ignored.
- [ ] Verify the account refreshes to its paid entitlement and can use the appropriate pod allowance. A free pod is already available; a paid checkout unlocks the plan's paid capabilities.
- [ ] In a permitted paid test account, approve pod direction and generate platform content through the deployed OpenAI route. Check the actual response, saved draft, reload persistence and content allowance. Record any provider billing/usage error separately from missing configuration.
- [ ] Deploy the reviewed production commit with the intended environment values, then repeat the required public-route and authenticated smoke checks. Keep unavailable publishing integrations accurately labelled.

For webhook troubleshooting, `stripe_not_configured` means Stripe server values are missing; `supabase_admin_not_configured` means provisioning configuration is missing; `signature_verification_failed` requires checking the exact endpoint secret and signed raw request. An ignored event is not successful paid activation.

## Final release evidence — complete before marking launch finished

| Evidence | Final result |
| --- | --- |
| Branch / final commit | `fix/launch-verification-20261114` / pending |
| Pull request / review | Pending |
| Final test and build results | 525/525 passing; Vite production build passed; `git diff --check` clean. |
| Preview deployment / smoke checks | Pending |
| Production deployment / commit | Pending |
| Stripe checkout → subscription → pod access | Pending |
| Authenticated OpenAI generation → saved draft → reload | Pending |

Record statuses, non-sensitive error categories and verification times here. Never add secret values, payment data or customer/account identifiers.
