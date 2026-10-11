import test from 'node:test';
import assert from 'node:assert/strict';
import { attachApprovedCalendarCreatives, decodeCalendarCreative, resolveCalendarCreative } from '../src/lib/calendarCreative.js';

const asset = { storagePath: 'pod/photo.jpg', preview: 'https://storage.test/photo?signature=secret', name: 'Brand photo' };
const post = { id: 'post1', platformKey: 'instagram', content: 'Actual approved caption' };
const review = { post_id: post.id, headline: 'Chosen headline', call_to_action: 'Explore', content_snapshot: post.content, status: 'approved', approved_at: '2026-10-11T10:00:00Z', image: { kind: 'upload', storage_path: asset.storagePath } };
const preference = { pod_id: 'pod1', active: true, preference_type: 'creative_review', created_at: '2026-10-11T12:00:00+02:00', preference_value: review };
const items = [2, 5].map(day => ({ platform: 'instagram', scheduled_date: `2026-10-0${day}`, caption: post.content, status: 'draft', approved: false, content_type: 'image' }));
const options = { podId: 'pod1', posts: [post], preferences: [preference], assets: [asset] };

test('attaches immutable artwork without changing dates, plan entries or publishing approvals', () => {
  const original = structuredClone(items);
  const attached = attachApprovedCalendarCreatives(items, options);
  assert.deepEqual(items, original);
  assert.deepEqual(attached.map(({ creative_note, ...rest }) => rest), items);
  assert.equal(attached.length, items.length);
  assert.equal(attached[0].creative_note.includes('signature'), false);
  const resolved = resolveCalendarCreative(attached[0], options);
  assert.equal(resolved.imageUrl, asset.preview);
  assert.equal(resolved.snapshot.headline, review.headline);
  assert.equal(resolved.snapshot.approved_at, '2026-10-11T10:00:00.000Z');
});

test('newer draft wins chronologically across offsets; stale captions and missing images are rejected', () => {
  const draft = { ...preference, created_at: '2026-10-11T05:01:00-05:00', preference_value: { ...review, status: 'draft' } };
  for (const overrides of [{ preferences: [draft, preference] }, { posts: [{ ...post, content: 'Changed caption' }] }, { assets: [] }, { preferences: [{ ...preference, preference_value: { ...review, content_snapshot: 'Old caption' } }] }, { podId: 'other' }]) {
    assert.equal(attachApprovedCalendarCreatives(items, { ...options, ...overrides })[0].creative_note, null);
  }
});

test('source preview resolves only observed allowed media; changed row caption rejects snapshot', () => {
  const media = { url: 'https://brand.test/logo.png', source_url: 'https://brand.test', role: 'brand_logo' };
  const sourceOptions = { ...options, sourceMedia: [media], preferences: [{ ...preference, preference_value: { ...review, image: { kind: 'source', url: media.url } } }] };
  const [item] = attachApprovedCalendarCreatives(items, sourceOptions);
  assert.equal(resolveCalendarCreative(item, sourceOptions).imageUrl, media.url);
  assert.equal(resolveCalendarCreative(item, { ...sourceOptions, sourceMedia: [] }), null);
  assert.equal(resolveCalendarCreative({ ...item, caption: 'Edited after scheduling' }, sourceOptions), null);
  assert.equal(resolveCalendarCreative(item, { ...sourceOptions, sourceMedia: [{ ...media, approval_status: 'rejected' }] }), null);
});

test('malformed notes are safe and typography approval is supported', () => {
  for (const note of [null, '{', '{}', 'Plain creative note', '{"kind":"dovroyn_calendar_creative","version":1}']) assert.equal(decodeCalendarCreative(note), null);
  const [item] = attachApprovedCalendarCreatives(items, { ...options, preferences: [{ ...preference, preference_value: { ...review, image: null } }] });
  assert.equal(resolveCalendarCreative(item, options).imageUrl, null);
});

test('selected platforms keep exactly the same campaign dates and allowance count', () => {
  const secondPost = { ...post, id: 'post2', platformKey: 'facebook' };
  const sameDateItems = items.flatMap((item) => [item, { ...item, platform: 'facebook' }]);
  const attached = attachApprovedCalendarCreatives(sameDateItems, { ...options, posts: [post, secondPost], preferences: [preference, { ...preference, preference_value: { ...review, post_id: secondPost.id } }] });
  assert.deepEqual(attached.map(({ creative_note, ...item }) => item), sameDateItems);
  assert.equal(new Set(attached.map(item => item.scheduled_date)).size, 2);
  assert.ok(attached.every(item => decodeCalendarCreative(item.creative_note)));
});
