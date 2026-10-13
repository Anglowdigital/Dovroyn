# Platform-neutral draft preview verification

Baseline: `28e3899422883ff54ada1159de9ed2488645c06d` (production PR #57).

The content panel now always renders the local creative editor. The existing Meta readiness/account-target predicate is passed to the editor and gates both exact-JPEG buttons and handlers, defaulting to false. Readiness participates in render invalidation. No API, migration, publishing, authentication, pricing, tier, or immutable snapshot changes.

Local headline, CTA and image selection remain transient until exact artwork approval; the UI states this. This change does not add draft persistence or permit non-Meta export.

## Verification

- `npm ci --cache /tmp/dovroyn-npm-cache` succeeded without lockfile changes. Initial default cache was unwritable.
- `npm test`: 425 passed, zero failures.
- `npm run build`: passed; existing large bundle warning remains.
- `node review/draft-preview-browser.mjs` with Playwright and system Chromium: passed at 1440×1000 and 390×844.
- `BASELINE=1 node review/draft-preview-browser.mjs`: reproduced missing editors on the verified production baseline at both sizes.
- Actual workspace fixture: Facebook, Instagram and LinkedIn show local previews; headline/CTA update in the DOM; supplied image bytes decode, typography selection removes the image, and reselecting restores it. Exact controls remain disabled; zero API calls.
- Connected editor fixture: simulated prepare response contains a real locally generated JPEG. Approval requires its load; edits and readiness loss invalidate it; fresh preparation and simulated approval complete. No owner account or production credentials are involved.
- Unit tests additionally cover late preview/approval responses, caption/account changes, readiness loss during preparation, and handler-level default denial.
- Independent agent reviewed the two production components and server prepare/approve paths: no blocking findings. Confirmed ownership, account binding, signed preparation, freshness, immutable render and publishing gates remain unchanged.
- Desktop/mobile before-and-after screenshots inspected. Screenshots and command logs are under `/tmp/dovroyn-browser` and `/tmp/dovroyn-*.log` in the coding environment.

All browser data is explicitly labelled as controlled fixtures. This is not authenticated owner-account acceptance, real Meta export, or live posting verification. No migrations, credentials, permissions, scheduler activation, posting, or paid generation were performed.
