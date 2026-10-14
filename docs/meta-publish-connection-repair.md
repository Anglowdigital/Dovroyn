# Explicit Meta publishing connections

Status: code and proposed SQL only. No OAuth request, credential generation, live Graph call, migration, permission grant, runtime activation, scheduled job, post, merge or deployment is included.

## User meaning

The explicit publishing connection asks Meta for permission to publish approved posts to the one account you choose. Account access does not approve a post: artwork, caption, account, date and exact time still require the existing separate publishing review.

Discovery remains the default. Existing discovery credentials retain their original token kind and scopes.

## Calling the existing seam

The existing client helper accepts an explicit option:

~~~js
await initiateMetaOrganicConnection({
  accessToken, podId, providerKey: 'instagram', connectionIntent: 'publish',
});
~~~

The authenticated server seam is still POST /api/integrations/meta/connect, with podId, providerKey, idempotencyKey and connectionIntent: "publish". A missing intent means discovery; unknown intents are rejected. No new publishing button or automatic permission request is added.

- Instagram publishing requests instagram_basic,pages_show_list,instagram_content_publish,pages_read_engagement.
- Facebook publishing requests pages_show_list,pages_manage_posts,pages_read_engagement.
- Each publishing flow can select only its requested provider. The linked Page for Instagram is derived from the stored provider-verified candidate, not submitted as a credential by the browser.
- Default Instagram discovery still requests instagram_basic,pages_show_list; Facebook discovery still requests pages_show_list.

The callback accepts intent and provider only from consumed, browser-bound server state. The selection POST cannot promote the pending intent. The selected owner, pod, provider, scopes, Page and linked Instagram identity are rechecked before atomic commit.

## Credential proof

The server enumerates /me/accounts with the user credential, validates actual granted user permissions via /me/permissions, then validates each returned Page credential against /debug_token using the existing app configuration. It requires a valid token, matching app and Page profile_id, granted scopes and usable expiry. If type is provided it must be PAGE; no mandatory undocumented granular-scopes shape is assumed.

It reads the enumerated Page with that Page credential and verifies response id and the linked instagram_business_account.id. Duplicate inconsistent Page credentials or ambiguous linked Instagram identities are rejected. The encrypted pending candidate binds credential proof to the exact Page token; a truthy credential-available display flag supplies no authority.

Publishing connections store encrypted Page credentials with verified Page/link/scope/expiry metadata and contract meta_organic_facebook_login_publish_selection_v1. Discovery and publishing use separate connection identities; reconnecting for publishing does not overwrite the existing discovery user token.

All provider interactions in automated verification use synthetic IDs and mocked transport. Fixtures establish code behavior, not live Meta assets or grants.

## Proposed database contract

The existing proposed connection migration is revised, together with two dependent account-resolution guards in the existing proposed publisher migration. The publisher proposal retains all 22 public RPC signatures and service-role execute grants unchanged. It retains discovery RPC arities and the v2 discovery readiness contract, adds server intent/provider fields, credential-verification metadata and a connection identity index including intent.

Two additional public SECURITY DEFINER RPCs have empty search paths and grant execute only to service_role:

- create_meta_organic_publish_oauth_state(text,text,uuid,uuid,text,text,text[],timestamptz) — 8 arguments.
- create_meta_organic_publish_pending_selection(text,uuid,uuid,timestamptz,timestamptz,text[],text,text,text,text) — 10 arguments.

The seven existing public RPC signatures remain unchanged; total public service execute grants in this proposal become nine. The private connection helper has an explicit trusted intent argument (4 arguments) and stays revoked from client and service roles. Existing commit row locks, owner checks, expiry checks, atomic rollback and replay consumption remain intact. Browser roles retain no access to private Meta tables or server RPCs; unrelated ACLs and rows are preserved.

Publishing additionally requires publish_connection_ready=true and the exact new capability contract from readiness. Plain discovery v2 readiness cannot admit publishing. Proposed schema extensions preserve prior rows as discovery; no stored user token is relabelled as a Page token.

## Disabled runtime and remaining live gates

The new path is disabled unless META_ORGANIC_PUBLISH_CONNECTIONS_ENABLED is exactly true, and still requires existing connection activation plus compatible storage. No environment setting is changed by this patch. Publisher and scheduler flags remain separate.

Before any live activation:

1. Verify the current Graph v26 Page-token debugger metadata contract against official documentation or an explicitly approved controlled test. Current documentation access was restricted; profile_id, app, validity, scope and expiry fields have historical primary-source support, not fresh live proof.
2. Review and specifically approve the proposed private schema, identity-index change and server RPC grants; inspect production state before application.
3. Approve the selected app/assets, actual publish permissions and secure server configuration. The patch uses the existing Facebook Login pathway and existing META_APP_ID; it does not switch to the separately labelled Instagram Login setup.
4. Obtain a fresh explicitly approved publishing connection. Old discovery tokens stay discovery.
5. Code-only deployment does not approve runtime activation. Approve activation separately, then approve exact content/account/date/time before any post or schedule.

When discovery and publishing records exist for the same provider account, consumers must bind the exact publishing accountConnectionId. The existing account picker distinguishes Account discovery and Publishing access when both exist, saves the exact chosen connection ID and preserves exact saved IDs regardless of response order. Legacy ambiguous snapshots and missing exact connections fail closed; prior artwork and approvals are not silently retargeted. The calendar publishing-review and artwork-export SQL boundaries also enforce exact supplied connection IDs. An ID-less legacy target remains compatible only when one eligible connection exists and its intent is discovery; duplicate matches and publish-only fallback reject with the existing context error codes. Each resolver uses a single STRICT lookup, preserving owner/pod/provider/account filters without a count-then-select race. Selecting publishing access replaces the draft default for that same platform account only through an explicit choice; it does not rewrite existing drafts.

## Local verification

~~~sh
node --test test/metaOrganic.test.js test/metaPublishConnection.test.js
PGLITE_MODULE=/tmp/dovroyn-pr48-sqlcheck/node_modules/@electric-sql/pglite/dist/index.js node docs/meta-publish-connection-pglite-check.mjs
~~~

The new PGlite harness uses an ephemeral synthetic schema only. Existing discovery/rollback and publisher SQL harnesses remain applicable.
