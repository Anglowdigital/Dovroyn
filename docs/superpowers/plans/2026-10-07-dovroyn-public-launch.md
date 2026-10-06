# Dovroyn Public Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Dovroyn truthful, safe to explore publicly, persistent for signed-in users and ready for production on its existing Vercel/Supabase stack.

**Architecture:** Keep the current React/Vite SPA, Vercel functions and Supabase schema. Public showcase behavior stays static; authenticated behavior writes structured state to existing Pod-owned relational tables and uses bounded, SSRF-safe analysis routes.

**Tech Stack:** React 19, Vite, Node test runner, Vercel Functions, OpenAI Responses API, Supabase/PostgREST.

**Spec:** `docs/superpowers/specs/2026-10-07-dovroyn-public-launch-design.md`

## Global Constraints

- Do not change the cream, navy and gold palette tokens.
- Do not change prices, entitlements, Stripe link names or payment flow.
- Do not add or modify Supabase schema or Vercel environment variables.
- Do not add embeddings/RAG; relational Supabase data remains authoritative.
- Do not claim unverified provider connections, publishing, spend, analytics or automatic monitoring.
- Preserve all unrelated working-tree changes, especially `supabase/migrations/20261001172046_harden_rls_auto_enable_execute.sql`.

## Review Focus

- A crafted public demo request must reach zero OpenAI calls.
- A crawl redirect or discovered link resolving to a private address must fail closed.
- A signed-in user must be unable to read or save state for another user's Pod.
- A reload must restore saved platform, calendar, campaign and budget decisions.
- Public copy must not imply live connections, real customer proof or measured performance.

---

### Task 1: Public landing, safe showcase and SEO

**Files:**
- Modify: `api/ai/chat.js`
- Modify: `src/App.jsx`
- Modify: `src/components/AiPodAssistant.jsx`
- Modify: `src/lib/aiClient.js`
- Modify: `src/pages/PodWorkspace.jsx`
- Modify: `src/lib/demoPod.js`
- Modify: `src/pages/pod-workspace.css`
- Create: `public/robots.txt`
- Create: `public/sitemap.xml`
- Modify: `index.html`
- Modify: `test/demoPod.test.js`
- Modify: `test/aiBoundary.test.js`
- Create: `test/landingBoundary.test.js`
- Create: `test/staticSeo.test.js`

**Interfaces:**
- Produces: a zero-network public assistant preview and a fully static `DemoPodShowcase` with accessible tabs.
- Consumes: existing route names, CSS variables and fictional fixture data.

- [ ] Write failing behavior tests for the approved hero/CTAs, removal of fabricated proof, zero-network public preview, 15 filled demo panels, tab semantics and static SEO files.
- [ ] Run the focused tests and confirm failures are caused by missing behavior.
- [ ] Implement the smallest public/demo/SEO changes while preserving palette and pricing contracts.
- [ ] Run focused tests, then `npm test`, and inspect the diff for price, Stripe or colour changes.
- [ ] Commit only Task 1 files.

### Task 2: Persist operational Pod state in existing Supabase tables

**Files:**
- Modify: `src/lib/podRepository.js`
- Modify: `src/pages/PodWorkspace.jsx`
- Create: `test/podPersistence.test.js`

**Interfaces:**
- Produces: `savePodPlatformSelection`, `savePodCalendar`, `savePodCampaignDecision`, `savePodBudgetDecision` and reload normalization helpers.
- Consumes: existing `pod_preferences`, `calendar_items`, `campaigns`, `budgets` and RLS ownership policies.

- [ ] Write failing repository tests for owner-scoped writes, stable upserts, explicit error handling and reload normalization.
- [ ] Run them and verify failure for missing persistence methods.
- [ ] Implement repository functions using existing tables only.
- [ ] Wire current controls to awaited writes and restore their state during `loadPodWorkspace`.
- [ ] Run focused tests, then `npm test`, and inspect that no migration or environment file changed.
- [ ] Commit only Task 2 files.

### Task 3: Rich bounded website intelligence

**Files:**
- Modify: `api/_lib/webSource.js`
- Create: `api/_lib/siteIntelligence.js`
- Modify: `api/ai/analyze.js`
- Modify: `src/lib/podRepository.js`
- Modify: `src/pages/PodWorkspace.jsx`
- Modify: `test/aiBoundary.test.js`
- Modify: `test/analyzeBoundary.test.js`
- Create: `test/siteIntelligence.test.js`

**Interfaces:**
- Produces: `fetchWebsiteIntelligence(url, options)` with bounded labelled pages and an expanded structured analysis response.
- Consumes: existing public-address validation, OpenAI response parsing and `savePodPreference`.

- [ ] Write failing tests for same-origin discovery, per-URL SSRF validation, page/byte/text caps, notes inclusion and richer structured fields.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the bounded crawl and expanded analysis schema/prompt.
- [ ] Persist the complete result as `website_intelligence` while keeping canonical `pod_analysis` behavior compatible.
- [ ] Run focused tests, then `npm test`, and inspect privacy/provenance behavior.
- [ ] Commit only Task 3 files.

### Task 4: On-demand Competitor Watch and real Learning History

**Files:**
- Create: `api/ai/competitors.js`
- Modify: `api/_lib/supabaseAuth.js`
- Modify: `api/_lib/podContext.js`
- Modify: `src/lib/aiClient.js`
- Modify: `src/lib/podRepository.js`
- Modify: `src/pages/PodWorkspace.jsx`
- Modify: `src/pages/pod-workspace.css`
- Modify: `src/lib/demoPod.js`
- Create: `src/lib/podLearning.js`
- Create: `test/competitorBoundary.test.js`
- Create: `test/podLearning.test.js`
- Modify: `test/demoPod.test.js`

**Interfaces:**
- Produces: authenticated `requestCompetitorSnapshot`, normalized learning events and two real signed-in tabs.
- Consumes: bounded site intelligence, `pod_preferences`, current Pod ownership verification and recent Pod context.

- [ ] Write failing tests for authentication/ownership, URL caps, citations, prohibited performance claims, chronological normalization and context limits.
- [ ] Run focused tests and confirm missing route/helpers fail.
- [ ] Implement the route, client/repository save path and learning normalizer.
- [ ] Render honest on-demand competitor and persisted learning panels; add fictional read-only equivalents to the demo.
- [ ] Run focused tests, then `npm test`, and inspect that no scheduler/provider claims were added.
- [ ] Commit only Task 4 files.

### Task 5: Integrated verification and production release

**Files:**
- Review all changed files; no new feature surface.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: reviewed, built, deployed and live-verified Dovroyn release.

- [ ] Run `git diff --check`, targeted safety/plan tests, full `npm test` and `npm run build` with fresh output.
- [ ] Run the local production preview and check `/`, `/demo-pod`, `/pricing`, `/signup`, `/login` and signed-in Pod behavior at desktop and mobile widths.
- [ ] Dispatch a fresh whole-branch code review and fix all Critical/Important findings test-first.
- [ ] Confirm the final diff contains no price, Stripe-link, palette, migration or environment changes.
- [ ] Integrate onto current `origin/main`, re-run clean verification, push `main`, verify the Vercel deployment is READY and test `https://dovroyn.com` plus static SEO files.
