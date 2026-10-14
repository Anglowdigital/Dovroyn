import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE);
const db = new PGlite();
const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000003';
const pod = '00000000-0000-4000-8000-000000000002';
const scopes = ['instagram_basic', 'pages_show_list', 'instagram_content_publish', 'pages_read_engagement'];
const encrypted = 'A'.repeat(64);
const expiry = new Date(Date.now() + 3600000).toISOString();
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
await db.exec(
  "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;" +
  "CREATE SCHEMA auth; CREATE SCHEMA private;" +
  "CREATE TABLE auth.users(id uuid PRIMARY KEY);" +
  "CREATE TABLE public.pods(id uuid PRIMARY KEY,user_id uuid);" +
  "CREATE TABLE private.unrelated_provider_data(id integer PRIMARY KEY);" +
  "CREATE TABLE public.social_connections(id uuid PRIMARY KEY);" +
  "GRANT USAGE ON SCHEMA private TO authenticated;" +
  "GRANT SELECT ON private.unrelated_provider_data TO authenticated;" +
  "GRANT SELECT,INSERT,UPDATE,DELETE ON public.social_connections TO authenticated;"
);
await db.query('INSERT INTO auth.users VALUES($1),($2)', [user, other]);
await db.query('INSERT INTO public.pods VALUES($1,$2)', [pod, user]);
await db.exec(readFileSync(new URL('../supabase/proposed-migrations/20261012000000_proposed_meta_organic_connection_cutover.sql', import.meta.url), 'utf8'));
await db.exec('SET ROLE service_role');
const pending = (hash, selectedUser = user) => db.query(
  "SELECT create_meta_organic_publish_pending_selection($1,$2,$3,now()+interval '10 minutes',now()+interval '1 hour',$4,$5,$6,$7,$8)",
  [hash, selectedUser, pod, scopes, encrypted, encrypted, 'test-v1', 'instagram']);
const get = hash => db.query('SELECT get_meta_organic_pending_selection($1,$2,$3) AS value', [hash, user, pod]);
const commit = (hash, payload, selectedUser = user) => db.query(
  'SELECT commit_meta_organic_account_selection($1,$2,$3,null,$4::jsonb) AS value',
  [hash, selectedUser, pod, JSON.stringify(payload)]);
const payload = {
  provider: 'instagram', providerAccountId: '201', accountLabel: 'Synthetic IG', grantedScopes: scopes,
  expiresAt: expiry, tokenKind: 'page', connectionIntent: 'publish', linkedFacebookPageId: '101',
  providerContractVersion: 'meta_organic_facebook_login_publish_selection_v1', providerVerifiedSource: 'meta_organic_server_v1',
  encryptedAccessToken: encrypted, encryptionKeyVersion: 'test-v1',
  credentialProof: {
    source: 'meta_page_token_debug_v1', appId: '123', pageId: '101', linkedInstagramAccountId: '201',
    tokenKind: 'page', tokenHash: 'b'.repeat(64), grantedScopes: scopes, expiresAt: expiry, verifiedAt: new Date().toISOString(),
  },
};
await check('publishing readiness requires the new intent-aware storage capability', async () => {
  const ready = (await db.query('SELECT get_meta_organic_connection_readiness() AS value')).rows[0].value;
  assert.equal(ready.ready, true);
  assert.equal(ready.publish_connection_ready, true);
  assert.equal(ready.publish_connection_contract_version, 'meta_organic_facebook_login_publish_selection_v1');
});
await check('publishing state preserves provider, exact scopes and server intent', async () => {
  await db.query("SELECT create_meta_organic_publish_oauth_state($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",
    ['1'.repeat(64),'2'.repeat(64),user,pod,'https://dovroyn.com/api/integrations/callback','instagram',scopes]);
  const state = (await db.query('SELECT consume_meta_organic_oauth_state($1,$2) AS value', ['1'.repeat(64),'2'.repeat(64)])).rows[0].value;
  assert.equal(state.connection_intent, 'publish');
  assert.equal(state.requested_provider, 'instagram');
  assert.deepEqual(state.required_scopes, scopes);
});
await check('publishing pending data is owner-bound and rejects null or absent scopes', async () => {
  await assert.rejects(pending('3'.repeat(64), other), /Pod not found/);
  for (const bad of [null, [], scopes.slice(0, 2)]) {
    await assert.rejects(db.query("SELECT create_meta_organic_publish_pending_selection($1,$2,$3,now()+interval '10 minutes',now()+interval '1 hour',$4,$5,$6,$7,$8)",
      ['3'.repeat(64),user,pod,bad,encrypted,encrypted,'test-v1','instagram']), /scope|permission/i);
  }
  await pending('3'.repeat(64));
  assert.equal((await get('3'.repeat(64))).rows[0].value.connection_intent, 'publish');
  assert.equal((await commit('3'.repeat(64), payload, other)).rows[0].value, null);
});
await check('publishing commit denies intent promotion, wrong kind, account proof, missing scopes and preserves pending', async () => {
  for (const bad of [
    { ...payload, connectionIntent: 'discovery' }, { ...payload, connectionIntent: null },
    { ...payload, tokenKind: 'user' }, { ...payload, grantedScopes: scopes.slice(0, 2) },
    { ...payload, linkedFacebookPageId: '999' }, { ...payload, providerAccountId: '999' },
    { ...payload, credentialProof: null },
    { ...payload, provider: 'facebook', providerAccountId: '101', grantedScopes: ['pages_show_list','pages_manage_posts','pages_read_engagement'],
      credentialProof: { ...payload.credentialProof, grantedScopes: ['pages_show_list','pages_manage_posts','pages_read_engagement'] } },
  ]) {
    await assert.rejects(commit('3'.repeat(64), bad), /intent|Page|scope|proof|credential|contract/i);
    assert.ok((await get('3'.repeat(64))).rows[0].value);
  }
});
await check('publishing connection remains separate from existing discovery user-token connection', async () => {
  await db.query("SELECT create_meta_organic_pending_selection($1,$2,$3,now()+interval '10 minutes',now()+interval '1 hour',$4,$5,$6,$7)",
    ['4'.repeat(64),user,pod,['instagram_basic','pages_show_list'],encrypted,encrypted,'test-v1']);
  const discovery = { ...payload, connectionIntent: 'discovery', tokenKind: 'user', credentialProof: undefined,
    grantedScopes: ['instagram_basic','pages_show_list'], providerContractVersion: undefined };
  await commit('4'.repeat(64), discovery);
  await commit('3'.repeat(64), payload);
  assert.equal((await commit('3'.repeat(64), payload)).rows[0].value, null);
  const rows = (await db.query('SELECT list_meta_organic_connections($1,$2) AS value', [user,pod])).rows[0].value;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.connection_intent).sort(), ['discovery','publish']);
  assert.ok(!JSON.stringify(rows).includes(encrypted));
});
await db.exec('RESET ROLE');
await check('stored publishing and discovery credential kinds remain distinct', async () => {
  const rows = (await db.query('SELECT c.connection_intent,k.token_kind FROM private.meta_organic_connections c JOIN private.meta_organic_credentials k ON c.id=k.connection_id ORDER BY c.connection_intent')).rows;
  assert.deepEqual(rows, [{ connection_intent: 'discovery', token_kind: 'user' }, { connection_intent: 'publish', token_kind: 'page' }]);
});
await check('unrelated ACLs and all browser denials are preserved', async () => {
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','private.unrelated_provider_data','SELECT') AS value")).rows[0].value, true);
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','public.social_connections','INSERT,UPDATE,DELETE') AS value")).rows[0].value, true);
  for (const role of ['anon','authenticated']) {
    await db.exec('SET ROLE ' + role);
    await assert.rejects(pending('5'.repeat(64)), /permission denied/);
    await assert.rejects(commit('5'.repeat(64), payload), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM private.meta_organic_credentials'), /permission denied/);
    await db.exec('RESET ROLE');
  }
});

await check('readiness denies authenticated access to publishing pending RPC', async () => {
  await db.exec('GRANT EXECUTE ON FUNCTION public.create_meta_organic_publish_pending_selection(text,uuid,uuid,timestamptz,timestamptz,text[],text,text,text,text) TO authenticated');
  await db.exec('SET ROLE service_role');
  const value = (await db.query('SELECT get_meta_organic_connection_readiness() AS value')).rows[0].value;
  await db.exec('RESET ROLE');
  await db.exec('REVOKE EXECUTE ON FUNCTION public.create_meta_organic_publish_pending_selection(text,uuid,uuid,timestamptz,timestamptz,text[],text,text,text,text) FROM authenticated');
  assert.equal(value.publish_connection_ready, false);
});
await check('readiness denies anon access to publishing state RPC', async () => {
  await db.exec('GRANT EXECUTE ON FUNCTION public.create_meta_organic_publish_oauth_state(text,text,uuid,uuid,text,text,text[],timestamptz) TO anon');
  await db.exec('SET ROLE service_role');
  const value = (await db.query('SELECT get_meta_organic_connection_readiness() AS value')).rows[0].value;
  await db.exec('RESET ROLE');
  await db.exec('REVOKE EXECUTE ON FUNCTION public.create_meta_organic_publish_oauth_state(text,text,uuid,uuid,text,text,text[],timestamptz) FROM anon');
  assert.equal(value.publish_connection_ready, false);
});

await db.close();
console.log(JSON.stringify({ passed, failed, environment: 'ephemeral synthetic PGlite; no production state' }));
process.exitCode = failed ? 1 : 0;
