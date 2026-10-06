# Dovroyn Public Launch Design

## Goal

Ship Dovroyn as a truthful public product whose showcase is safe to explore and whose signed-in Pods save operational state in the existing Supabase database.

## Product boundaries

- Preserve the existing cream, navy and gold palette exactly.
- Preserve current plans, prices, pod limits, Stripe product names and all eight `VITE_STRIPE_*` links.
- Preserve the existing Supabase project, authentication, RLS model, Vercel project and environment variables.
- Do not introduce embeddings or RAG in this release. Approvals, preferences, budgets, dates, subscriptions, permissions and connection state remain deterministic relational data.
- Do not claim that an external account is connected, content is published, spend changed, analytics are live or competitors are continuously monitored unless verified provider data proves it.

## Public site

The landing page uses the approved headline `EVERY BRAND GETS ITS OWN AI BRAIN`, retains the existing visual system and provides direct routes to sign up, the demo Pod and pricing. Fabricated testimonials and unverified performance figures are replaced by factual product principles. Public metadata, `robots.txt` and `sitemap.xml` make the public routes indexable while excluding authenticated routes.

The anonymous homepage AI widget becomes a prepared local demonstration. It must not call OpenAI or Supabase. The real Pod AI remains available only inside an authenticated Pod.

## Demo Pod

The public Demo Pod is a fictional, fully populated, read-only workspace. Every sidebar item opens a filled sample panel. It cannot upload, connect, ask AI, save, approve, schedule, publish or spend. Crafted demo requests are rejected by the server before reaching OpenAI. Competitor Watch and Learning History are clearly labelled fictional samples.

## Signed-in Pod intelligence

Website analysis expands from one page to a bounded same-origin crawl. It validates every URL and redirect against private-network targets, caps pages and total readable text, and preserves source labels. The structured result includes products/services, visual direction, site structure, strongest and weakest pages, audience fit and SEO/content opportunities.

The canonical analysis remains in `pod_analysis`; the complete snapshot is saved in the existing `pod_preferences` JSONB table with source `observed_result`. This preserves richer fields across reloads without a schema or environment change.

Competitor Watch is authenticated and on demand. A user can compare up to three public competitor URLs; the route performs bounded public-page analysis and returns cited positioning differences. The result is saved as a `competitor_snapshot` preference. The UI says “on-demand public snapshot” and never claims traffic, ad performance, outperforming or continuous monitoring.

Learning History is built from real persisted events: analysis snapshots, direction overrides and approvals, platform choices, content edits, calendar creation, campaign decisions, budget decisions and competitor snapshots. These structured recent records are also usable by future applications through Supabase and can be included in Pod AI context. Embeddings may later be added only as a derived search index for large documents or long history; they never replace the relational source of truth.

## Operational persistence

Existing Supabase tables remain the source of truth:

- `subscriptions` for tier, status, allowance and period state;
- `pod_preferences` for approved/observed/user-directed Pod memory;
- `calendar_items` and `social_posts` for dates and content state;
- `campaigns` for campaign lifecycle;
- `budgets` and `ad_analysis` for plans and approval decisions;
- `social_connections` for provider/account status only, with credentials kept in the private schema;
- `agent_action_requests` and `agent_audit_events` for explicit action approval and audit history.

The frontend must stop treating calendar, campaign, selected-platform and budget decisions as session-only. Each existing user action writes through the repository and reload restores the saved state. All writes remain Pod-owned and RLS-protected.

## Release evidence

Each behavior is implemented test-first. Completion requires the focused tests, full `npm test`, `npm run build`, desktop/mobile browser checks, a fresh code review, a scoped Git diff, a push to the verified `Jaelar87/Dovroyn` main branch and a successful Vercel production deployment verified at `https://dovroyn.com`.
