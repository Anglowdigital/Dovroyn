# Dovroyn visual and own-site review package

Branch: `feat/editorial-visual-upgrade`, isolated from main `fbf4dd9`.
Scope expanded by the parent during implementation from visual-only work to optional-logo URL intake, source evidence, and editable visual creative review. No other repository or stalled working branch was changed.

## Implemented

- Benefit-led cream/ivory/navy/gold homepage with locally bundled Playfair Display, layered image/creative previews and working signup/demo CTAs.
- Original Dovroyn promotional concepts using the existing Dovroyn logo and actual interface captures. These are review concepts, not published advertisements.
- Pod workflow strip; uploaded brand logos and photography on real pod library cards; real persisted status labels; platform glyphs in brand colours; source gallery, responsive creative and calendar layouts.
- URL intake no longer requires a logo. Photos-only intake still requires photos. New pods open Sources; existing analysed pods open Analysis & Review.
- Bounded observed website metadata and same-origin images are returned with provenance and persisted. Accessible SPA shells are explicitly labelled metadata-only. No browser rendering is claimed. Dovroyn source extraction excludes its fictional Aurora demo assets.
- Per-post visual creative editor using uploaded/observed assets, editable headline and CTA, persisted drafts and explicit approval. Signed storage URLs are not persisted. Captions are snapshotted; caption or creative edits invalidate the displayed approval. Nothing is published or scheduled by approval.

## Evidence

Production build succeeds. `npm test`: **281 passing, 0 failing**. `git diff --check` clean.

[Browser results](browser-checks.json): all eight linked public routes rendered; all 15 demo tabs and wrapping arrow/Home navigation worked; no browser JavaScript errors; no page overflow at 1440px/390px. Axe WCAG 2 A/AA + 2.1 AA checks report zero violations on the homepage and pod-platform screen at both widths. This is an automated scan, not a claim of complete accessibility certification.

Controlled UI fixture checks verify editable creative, persisted-save response handling, explicit approval, caption invalidation and failed-save errors. URL intake is browser-valid without a logo; photos-only intake without photos is invalid. A controlled Supabase fixture also exercises the full URL-only create handler, confirms no logo upload is attempted and verifies navigation to the new pod. These are **local fixtures, not live account verification**.

| Surface | Desktop | Mobile |
| --- | --- | --- |
| Homepage | [Screenshot](screenshots/home-desktop.png) | [Screenshot](screenshots/home-mobile.png) |
| Pod source gallery | [Screenshot](screenshots/pod-desktop.png) | [Screenshot](screenshots/pod-mobile.png) |
| Pod platforms | [Screenshot](screenshots/platforms-desktop.png) | [Screenshot](screenshots/platforms-mobile.png) |
| Pod calendar | [Screenshot](screenshots/calendar-desktop.png) | [Screenshot](screenshots/calendar-mobile.png) |
| Source intake (fixture) | [Screenshot](screenshots/source-intake-fixture.png) | [Screenshot](screenshots/source-intake-mobile-fixture.png) |

[Pod library fixture](screenshots/pod-library-fixture.png) · [Editable creative fixture](screenshots/creative-editor-fixture.png) · [Brand ad concept](screenshots/dovroyn-ad-brand.png) · [Direction ad concept](screenshots/dovroyn-ad-direction.png)

## Integration ownership

Meta PR #48 was inspected read-only at `8785e7f73af185b98e3b0522e70f316162d8d004`; it is not merged here. A three-way file merge against the shared base finds two conflicts in `src/pages/PodWorkspace.jsx`:

1. Platform selection row: retain Meta connection summary/button/handler and use this branch's `PlatformMark` in place of the old two-letter monogram.
2. Adjacent modal definitions: retain Meta's connect/error modals and this branch's optional-logo source message and truthful draft-calendar message.

Both branches also extend the existing UI test harness module maps; keep the added stubs/imports from both. This branch changes `App.jsx` only at imports, hero placement, promotional examples, sample labels and platform icon presentation. Styling is in `visual-upgrade.css`; `index.css` only loses the external Google Fonts import. No Meta backend/auth files or pricing/entitlement rules are changed.

## Remaining blockers and tracked gaps

- **Not merged or deployed.** Parent reconciliation/review and verified production smoke test remain required.
- **Reference pixels unreviewed.** Library `libfile_31af108c90ec819198b8c6a0f9aadcd1` was prepared with a consumer-local destination, but its supported transfer failed to download readable bytes. No claim of pixel fidelity to `44386.jpg` is made.
- **Live own-site run unverified.** No authenticated Dovroyn session or configured local app environment was supplied. Container requests to dovroyn.com and its logo were denied with proxy HTTP 403; this does not establish that production extraction is blocked. Parent must create a real Dovroyn URL pod, run server-side AI analysis, review actual source details, save/restore creative and verify tier behavior in the live account after integration.
- **Calendar still stores draft captions.** Creative approvals are saved separately; approved artwork snapshots are not yet linked into calendar entries or provider execution. Same-date and tier scheduling rules are preserved and tested.
- **Video generation and real coming-soon publishing remain absent.** Existing photos-only input is preserved. No new image/video provider call, OAuth grant, spend, social publishing or recurring promotion is performed.
- URL-only pod cards use initials until a logo is uploaded; observed source imagery is available for review/creative selection inside the pod. No guessed logo is substituted.

## Asset provenance

`public/dovroyn-logo.png` is the pre-existing supplied logo. `public/demo/aurora-products.png` is newly AI-generated **fictional demonstration imagery**, not a customer/product result. `pod-*-preview.png` files capture the actual read-only fictional demo UI. Font files are from `@fontsource/playfair-display` 5.3.0; the OFL licence is included in `public/fonts/`.

## Reproduce the local browser checks

Start `npm run dev -- --host 0.0.0.0 --port 4173`. With Playwright, Chromium and axe-core available, run `node docs/visual-upgrade/browser-check.cjs` and `node docs/visual-upgrade/intake-check.cjs` from the repository root. Optional `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH` and `AXE_SCRIPT` environment variables select existing tool installations without changing package dependencies. The development-only fixture files use explicitly intercepted I/O in these scripts; they are not a live-login bypass or production route.
