# Dovroyn

Dovroyn is a React + Vite application for private AI marketing pods, with:

- Dedicated pod-first landing and navigation experience
- Login and signup with Supabase Auth
- A lean outer pod library and a rich workspace inside each pod
- Website/photo intake, AI direction approval and overrides, assets, social content, calendars, campaigns, analytics, collaborations, coming-soon pages, and budget/ad review
- Server-side OpenAI web research for private pod chat, plus optional Amazon Bedrock for authenticated analysis, competitor snapshots and approval-gated content generation; the public preview uses local examples
- Dovroyn's responsive cream, navy, and gold interface with charts, modals, motion, and a command palette
- Supabase Auth, private storage, row-level ownership policies, and pod persistence
- Four recurring Stripe subscription tiers with monthly allowance windows

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
3. Add the required browser and server values listed in `.env.example`. Keep `OPENAI_API_KEY` server-only and never prefix it with `VITE_`. OpenAI remains the default provider. `OPENAI_MODEL` changes its shared model and workload-specific variables override individual routes. To use Bedrock alongside OpenAI, follow [Bedrock setup](docs/bedrock-setup.md); configure the AWS role, region and model before changing a provider selector.
4. Run locally:
   ```bash
   npm run dev
   ```

## Build

```bash
npm run build
```

Run the rule tests with:

```bash
npm test
```

## Supabase

Review and run the SQL files in order:

1. `supabase-migration.sql`
2. `supabase-pod-workspace-migration.sql`
3. `supabase-pod-source-lock-migration.sql`
4. `supabase/migrations/20260925000000_agent_safety_foundation.sql`

The later migrations lock analysed sources and add evidence provenance, explicit research/draft/approve/execute action levels, human approval records, idempotency controls, and an append-only audit trail. They are not applied automatically.

## Release gate

Paid checkout is created by `/api/stripe/checkout` after Supabase authentication. It
resolves the configured Payment Link for the chosen plan, validates the exact AUD
price and recurring interval, and binds the Checkout Session and subscription to
the authenticated user. Both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` must be
configured before checkout opens. Browser input cannot supply a price or account ID.

See [launch verification and Stripe setup](docs/launch-verification-20261114.md) for
the observed production blockers, secure configuration steps and live acceptance checks.

Do not deploy solely because the build passes. First validate Stripe links and webhooks, run all migrations in the intended Supabase project, configure server-only API variables, complete each social provider's OAuth approval, and perform the landing/pod button audit described in `DOVROYN_PRODUCT_SPEC.md`.
