import test from 'node:test';
import assert from 'node:assert/strict';
import { creativeImageCandidates, imageReferenceKey, latestCreativeReview, creativeReviewPayload, initialCreativeHeadline, creativeReviewIsCurrent } from '../src/lib/creativeReview.js';

test('only supplied safe imagery is selectable; uploads persist storage paths, not temporary URLs', () => {
  const images = creativeImageCandidates([
    { storagePath: 'pod/asset.jpg', preview: 'https://storage.test/asset?token=temporary', assetRole: 'product', name: 'Product' },
    { storagePath: 'bad', preview: 'javascript:alert(1)' },
  ], [{ url: 'https://brand.test/image.jpg', source_url: 'https://brand.test', alt: 'Brand photo' }, { url: 'https://brand.test/rejected.jpg', approval_status: 'rejected' }]);
  assert.equal(images.length, 2);
  const payload = creativeReviewPayload('post1', 'Actual copy', 'Read more', images[0], true);
  assert.deepEqual(payload.image, { kind: 'upload', storage_path: 'pod/asset.jpg' });
  assert.equal(JSON.stringify(payload).includes('temporary'), false);
  assert.equal(imageReferenceKey(payload.image), images[0].key);
  assert.equal(payload.status, 'approved');
  assert.ok(payload.approved_at);
  const sourcePayload = creativeReviewPayload('post1', 'Actual copy', 'Read more', images[1], false);
  assert.deepEqual(sourcePayload.image, { kind: 'source', url: 'https://brand.test/image.jpg', source_url: 'https://brand.test' });
  assert.equal(imageReferenceKey(sourcePayload.image), images[1].key);
});

test('restoration is scoped to pod and post, newest decision wins over prior approval', () => {
  const pref = (pod, post, status, date) => ({ pod_id: pod, preference_type: 'creative_review', active: true, created_at: date, preference_value: { post_id: post, status } });
  const rows = [pref('a', 'p', 'approved', '2026-10-01'), pref('a', 'p', 'draft', '2026-10-02'), pref('b', 'p', 'approved', '2026-10-03'), pref('a', 'other', 'approved', '2026-10-03')];
  assert.equal(latestCreativeReview(rows, 'a', 'p').status, 'draft');
  assert.equal(latestCreativeReview(rows, 'missing', 'p'), null);
});

test('draft save clears approval and accepts typography only; blank headline is rejected', () => {
  const payload = creativeReviewPayload('p', ' Headline ', ' CTA ', null, false);
  assert.equal(payload.status, 'draft');
  assert.equal(payload.approved_at, null);
  assert.equal(payload.image, null);
  assert.equal(payload.composition.typography_only, true);
  assert.equal(payload.source_evidence.kind, 'typography_only');
  assert.throws(() => creativeReviewPayload('p', ' ', '', null, true));
});

test('headline uses only the first actual sentence and caps long copy', () => {
  assert.equal(initialCreativeHeadline('Your marketing, organised. Review your next creative.'), 'Your marketing, organised.');
  assert.equal(initialCreativeHeadline('a'.repeat(200)).length, 140);
  assert.equal(initialCreativeHeadline(), '');
});

test('caption changes invalidate approval and source brand logos retain logo treatment', () => {
  const review = creativeReviewPayload('p', 'My chosen headline', 'Read more', null, true, 'Original caption');
  assert.equal(creativeReviewIsCurrent(review, 'Original caption'), true);
  assert.equal(creativeReviewIsCurrent(review, 'Edited caption'), false);
  assert.equal(creativeReviewIsCurrent({ status: 'approved' }, 'Original caption'), false);
  assert.equal(review.headline, 'My chosen headline');
  assert.equal(creativeImageCandidates([], [{ url: 'https://brand.test/logo.png', role: 'brand_logo' }])[0].role, 'logo');
});
