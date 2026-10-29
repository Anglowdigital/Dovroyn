import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { persistCreativeDraft } from '../src/lib/creativeDraft.js';
import { creativeImageCandidates, latestCreativeReview } from '../src/lib/creativeReview.js';
import { attachApprovedCalendarCreatives } from '../src/lib/calendarCreative.js';

function store({ reject = false, mutate = row => row } = {}) {
  const rows = [], requests = [];
  const client = createClient('https://controlled-draft-fixture.example', 'fixture-public-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      const payload = JSON.parse(options.body); requests.push({ url, method: options.method, payload });
      if (reject) return new Response(JSON.stringify({ message: 'new row violates row-level security policy' }), { status: 403 });
      const row = mutate({ id: 'draft-revision', created_at: '2026-10-13T20:00:00.000001Z', ...payload });
      rows.push(row);
      return new Response(JSON.stringify(row), { status: 201, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { client, rows, requests };
}
const post = { id: 'post-1', content: 'Saved caption', platformKey: 'facebook', targetAccounts: [{ provider: 'facebook', providerAccountId: 'unchanged-account' }] };
const asset = { storagePath: 'owner/pod/photo.jpg', preview: 'https://storage.example/photo?token=temporary', name: 'Owner photo' };

test('draft persistence appends only owner-pod creative preference and restores stable image references', async () => {
  for (const selected of [...creativeImageCandidates([asset], [{ url: 'https://brand.example/photo.jpg', source_url: 'https://brand.example', alt: 'Observed source' }]), null]) {
    const db = store();
    const originalPost = structuredClone(post);
    const row = await persistCreativeDraft(db.client, 'pod', post, 'My headline', 'Read more', selected, 'Brand');
    assert.equal(db.requests.length, 1);
    assert.match(db.requests[0].url, /\/rest\/v1\/pod_preferences\?select=/);
    assert.equal(db.requests[0].method, 'POST');
    assert.deepEqual(post, originalPost);
    assert.equal(row.pod_id, 'pod'); assert.equal(row.active, true);
    const restored = latestCreativeReview(db.rows, 'pod', post.id);
    assert.equal(restored.headline, 'My headline'); assert.equal(restored.call_to_action, 'Read more');
    assert.deepEqual(restored.image, selected?.reference || null);
    assert.equal(restored.status, 'draft'); assert.equal(restored.approved_at, null);
    assert.equal(restored.server_attestation, undefined); assert.equal(restored.final_render_evidence, undefined);
    assert.equal(JSON.stringify(restored).includes('temporary'), false);
    assert.equal(latestCreativeReview(db.rows, 'another-pod', post.id), null);
  }
});

test('persisted draft supersedes approval for new calendar attachments and preserves existing snapshots', async () => {
  const approved = { id: 'approval-1', pod_id: 'pod', preference_type: 'creative_review', active: true, created_at: '2026-10-13T19:59:59Z', preference_value: { post_id: post.id, content_snapshot: post.content, status: 'approved', approved_at: '2026-10-13T19:59:59Z', headline: 'Approved headline', image: { kind: 'upload', storage_path: asset.storagePath } } };
  const items = [{ platform: 'facebook', scheduled_date: '2026-10-14', caption: post.content, status: 'draft' }];
  const options = { podId: 'pod', posts: [post], preferences: [approved], assets: [asset] };
  const existing = attachApprovedCalendarCreatives(items, options);
  assert.ok(existing[0].creative_note);
  const snapshot = structuredClone(existing), previous = structuredClone(approved);
  const db = store();
  const draft = await persistCreativeDraft(db.client, 'pod', post, 'Edited headline', '', creativeImageCandidates([asset], [])[0], 'Brand');
  const fresh = attachApprovedCalendarCreatives(items, { ...options, preferences: [draft, approved] });
  assert.equal(fresh[0].creative_note, null);
  assert.deepEqual(existing, snapshot); assert.deepEqual(approved, previous);
});

test('RLS denial and unconfirmed writes never become successful draft saves', async () => {
  await assert.rejects(persistCreativeDraft(store({ reject: true }).client, 'other-owner-pod', post, 'Headline', '', null, 'Brand'), /row-level security/);
  for (const mutate of [
    row => ({ ...row, id: null }), row => ({ ...row, pod_id: 'other-pod' }), row => ({ ...row, active: false }),
    row => ({ ...row, preference_type: 'social_post_target_snapshot' }), row => ({ ...row, created_at: 'invalid' }),
    row => ({ ...row, preference_value: { ...row.preference_value, status: 'approved' } }),
    row => ({ ...row, preference_value: { ...row.preference_value, post_id: 'another-post' } }),
    row => ({ ...row, preference_value: { ...row.preference_value, headline: 'Stale echo' } }),
    row => ({ ...row, preference_value: { ...row.preference_value, image: { kind: 'upload', storage_path: 'wrong.jpg' } } }),
    row => ({ ...row, preference_value: { ...row.preference_value, server_attestation: 'unexpected' } }),
  ]) await assert.rejects(persistCreativeDraft(store({ mutate }).client, 'pod', post, 'Headline', '', null, 'Brand'), /could not be confirmed/);
});

test('navigation saves for the same pod/post are serialized so an old slow write cannot land last', async () => {
  let release;
  const requests = [];
  const client = createClient('https://controlled-draft-fixture.example', 'fixture-public-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (_url, options) => {
      const payload = JSON.parse(options.body); requests.push(payload);
      if (requests.length === 1) await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ id: `revision-${requests.length}`, created_at: new Date().toISOString(), ...payload }), { status: 201 });
    } },
  });
  const oldSave = persistCreativeDraft(client, 'pod', post, 'Old editor', '', null, 'Brand');
  await new Promise(resolve => setImmediate(resolve));
  const newSave = persistCreativeDraft(client, 'pod', post, 'Returned editor', '', null, 'Brand');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  release();
  const [oldRow, newRow] = await Promise.all([oldSave, newSave]);
  assert.equal(requests.length, 2);
  assert.equal(oldRow.preference_value.headline, 'Old editor');
  assert.equal(newRow.preference_value.headline, 'Returned editor');
  assert.deepEqual(requests.map(row => row.preference_value.headline), ['Old editor', 'Returned editor']);
});
