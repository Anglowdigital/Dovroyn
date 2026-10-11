// Execute the actual migration function in isolated PostgreSQL (PGlite).
// This validates function behavior; it does not validate production RLS/migration state.
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
  const db = new PGlite();
  const owner = '11111111-1111-4111-8111-111111111111';
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${owner}'::uuid $$;
    CREATE TABLE public.pods (id uuid PRIMARY KEY, user_id uuid, source_locked_at timestamptz, source_type text, source_url text, status text, updated_at timestamptz);
    CREATE TABLE public.pod_assets (pod_id uuid, asset_role text);
    CREATE TABLE public.pod_analysis (pod_id uuid PRIMARY KEY, brand_summary text, tone text, audience text, offer_direction text, campaign_angles text, social_recommendations text, content_ideas text, brand_colours jsonb, geography jsonb, evidence jsonb, confidence numeric, source_captured_at timestamptz, personal_data_detected boolean, personal_data_categories text[], updated_at timestamptz);`);
  await db.exec(readFileSync('supabase/migrations/20261011233000_optional_logo_analysis.sql', 'utf8'));
  const payload = {summary:'Observed source',brand_colours:[],geography:[],confidence:0.5};
  let seq=0;
  async function pod(type='website',url='https://dovroyn.com',user=owner) {
    const id=`22222222-2222-4222-8222-${String(++seq).padStart(12,'0')}`;
    await db.query('INSERT INTO pods(id,user_id,source_type,source_url) VALUES($1,$2,$3,$4)',[id,user,type,url]);return id;
  }
  const finalize=(id,value=payload)=>db.query('SELECT public.finalize_pod_analysis($1,$2::jsonb)',[id,JSON.stringify(value)]);
  for (const type of ['website','social','shopify']) {
    const id=await pod(type);await finalize(id);
    const row=(await db.query('SELECT source_locked_at,status FROM pods WHERE id=$1',[id])).rows[0];
    assert.ok(row.source_locked_at);assert.equal(row.status,'awaiting_direction');
    await assert.rejects(finalize(id),/already been analysed/);
  }
  await assert.rejects(finalize(await pod('website','')),/primary URL/);
  await assert.rejects(finalize(await pod('unsupported')),/supported primary/);
  await assert.rejects(finalize(await pod('photos',null)),/at least one brand photo/);
  const photos=await pod('photos',null);await db.query("INSERT INTO pod_assets VALUES($1,'brand_photo')",[photos]);await finalize(photos);
  await assert.rejects(finalize(await pod('website','https://example.com','33333333-3333-4333-8333-333333333333')),/not owned/);
  const malformed=await pod();await assert.rejects(finalize(malformed,{...payload,brand_colours:{}}),/valid colour and geography/);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM pod_analysis WHERE pod_id=$1',[malformed])).rows[0].count,0);
  assert.equal((await db.query('SELECT source_locked_at FROM pods WHERE id=$1',[malformed])).rows[0].source_locked_at,null);
  assert.equal((await db.query("SELECT proconfig,prosecdef FROM pg_proc WHERE proname='finalize_pod_analysis'")).rows[0].prosecdef,false);
  await db.close();console.log('PostgreSQL function checks passed: URL/no-logo, photos-only, source lock, owner, source type, payload failure atomicity and SECURITY INVOKER.');
})().catch(error=>{console.error(error);process.exit(1)});
