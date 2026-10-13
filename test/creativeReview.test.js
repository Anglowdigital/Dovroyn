import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
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

async function creativeReviewHarness(services = {}) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let tree;
  const h = (type, props, ...children) => typeof type === 'function'
    ? type({ ...props, children }) : { type, props: props || {}, children: children.flat(Infinity).filter((child) => child != null && child !== false) };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      const changed = !previous || !Array.isArray(deps) || deps.length !== previous.length || deps.some((dep, depIndex) => !Object.is(dep, previous[depIndex]));
      slots[index] = deps;
      if (changed) effects.push(fn);
    },
    useId() { cursor++; return 'field-id'; },
  };
  const notices = [];
  const saved = [];
  const modules = {
    react: hooks,
    '../../lib/creativeReview.js': await import('../src/lib/creativeReview.js'),
    '../../lib/metaOrganic.js': {
      prepareMetaArtworkReview: services.prepareMetaArtworkReview || (async () => ({
        preparationToken: 'prep-token',
        accountSnapshotFingerprint: 'snapshot-hash',
        image: { dataUrl: 'data:image/jpeg;base64,AAAA', dimensions: { width: 1080, height: 1350 } },
      })),
      approveMetaArtworkReview: services.approveMetaArtworkReview || (async () => ({ approval: { id: 'approval-1' }, exports: [{ manifestHash: 'm' }] })),
    },
  };
  let source = readFileSync(new URL('../src/components/pod/CreativeReview.jsx', import.meta.url), 'utf8');
  source = source.replace(/import\s+({[\s\S]*?}|[\w]+)\s+from\s+'([^']+)';/g, (_, names, module) => names.startsWith('{')
    ? `const ${names} = modules[${JSON.stringify(module)}];` : `const ${names} = modules[${JSON.stringify(module)}].default;`)
    .replace('export default function CreativeReview', 'function CreativeReview');
  const { code } = await transformWithOxc(source, 'CreativeReview.jsx', { jsx: { runtime: 'classic', pragma: 'h' } });
  const Component = new Function('modules', 'h', `${code}; return CreativeReview;`)(modules, h);
  const props = {
    podId: 'pod-1',
    canReviewExactMetaArtwork: true,
    accessToken: 'token',
    brandName: 'Brand',
    post: { id: 'post-1', content: 'Fresh caption', platformName: 'Facebook', targetAccounts: [{ provider: 'facebook', providerAccountId: '101', accountLabel: 'Page' }] },
    assets: [{ storagePath: 'owner/pod-1/image.jpg', preview: 'https://asset.example/image.jpg', assetRole: 'campaign_asset', name: 'Image', type: 'image/jpeg' }],
    sourceMedia: [],
    savedPreferences: [],
    onNotice: (message) => notices.push(message),
    onSaved: (row) => saved.push(row),
  };
  const render = () => { cursor = 0; effects.length = 0; tree = Component(props); effects.splice(0).forEach((effect) => effect()); return tree; };
  const nodes = (node = tree) => typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'object' ? (node.children || []).map(text).join(' ') : String(node);
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node).trim() === label);
  render();
  return { props, render, nodes, text, button, notices, saved, flush: async () => { await new Promise((resolve) => setImmediate(resolve)); render(); } };
}

test('fresh prepared render enables approval only after exact JPEG loads', async () => {
  let approved = 0;
  const harness = await creativeReviewHarness({ approveMetaArtworkReview: async () => { approved += 1; return { approval: { id: 'approval-1' }, exports: [{ manifestHash: 'm' }] }; } });
  assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
  harness.button('Prepare exact JPEG').props.onClick();
  await harness.flush();
  assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
  const image = harness.nodes().find((node) => node.type === 'img' && node.props.alt === 'Exact rendered artwork for approval');
  assert.ok(image, 'rendered JPEG preview is shown');
  image.props.onLoad();
  harness.render();
  assert.equal(harness.button('Approve rendered JPEG').props.disabled, false);
  harness.button('Approve rendered JPEG').props.onClick();
  await harness.flush();
  assert.equal(approved, 1);
  assert.equal(harness.saved[0].id, 'approval-1');
});

for (const change of ['caption', 'accounts']) {
  test(`late approval response cannot approve changed ${change}`, async () => {
    let resolveApproval;
    const pending = new Promise((resolve) => { resolveApproval = resolve; });
    const harness = await creativeReviewHarness({ approveMetaArtworkReview: () => pending });
    harness.button('Prepare exact JPEG').props.onClick();
    await harness.flush();
    harness.nodes().find((node) => node.type === 'img' && node.props.alt === 'Exact rendered artwork for approval').props.onLoad();
    harness.render();
    harness.button('Approve rendered JPEG').props.onClick();
    harness.props.post = { ...harness.props.post, ...(change === 'caption' ? { content: 'Changed caption' } : { targetAccounts: [{ provider: 'facebook', providerAccountId: '202' }] }) };
    harness.render();
    resolveApproval({ approval: { id: 'old-approval' }, exports: [{ manifestHash: 'old' }] });
    await harness.flush();
    assert.equal(harness.saved.length, 0);
    assert.match(harness.text(), /Unsaved draft/);
    assert.equal(harness.notices.some((notice) => notice.startsWith('Creative approved')), false);
  });
}

test('late preview response is discarded after caption changes', async () => {
  let resolvePreview;
  const pending = new Promise((resolve) => { resolvePreview = resolve; });
  const harness = await creativeReviewHarness({ prepareMetaArtworkReview: () => pending });
  harness.button('Prepare exact JPEG').props.onClick();
  harness.props.post = { ...harness.props.post, content: 'Changed caption' };
  harness.render();
  resolvePreview({ preparationToken: 'old-token', image: { dataUrl: 'data:image/jpeg;base64,AAAA', dimensions: { width: 1080, height: 1350 } } });
  await harness.flush();
  assert.equal(harness.nodes().some((node) => node.type === 'img' && node.props.alt === 'Exact rendered artwork for approval'), false);
  assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
});

for (const platformName of ['Facebook', 'Instagram', 'LinkedIn']) {
  test(`${platformName} local draft remains editable without Meta and cannot prepare or export`, async () => {
    let calls = 0;
    const harness = await creativeReviewHarness({ prepareMetaArtworkReview: async () => { calls++; }, approveMetaArtworkReview: async () => { calls++; } });
    harness.props.canReviewExactMetaArtwork = false;
    harness.props.accessToken = undefined;
    harness.props.post = { ...harness.props.post, platformName, targetAccounts: [] };
    harness.render();
    assert.ok(harness.nodes().find(node => node.props['aria-label'] === 'Ad draft preview'));
    for (const [type, value] of [['textarea', 'Local headline'], ['input', 'Local CTA'], ['select', '']]) {
      const field = harness.nodes().find(node => node.type === type);
      assert.equal(field.props.disabled, false);
      field.props.onChange({ target: { value } });
      harness.render();
    }
    assert.match(harness.text(), /Local headline/);
    assert.match(harness.text(), /Local CTA/);
    assert.equal(harness.nodes().some(node => node.type === 'img'), false, 'typography selection removes uploaded image');
    assert.equal(harness.button('Prepare exact JPEG').props.disabled, true);
    assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
    await harness.button('Prepare exact JPEG').props.onClick();
    await harness.button('Approve rendered JPEG').props.onClick();
    assert.equal(calls, 0);
    assert.equal(harness.saved.length, 0);
  });
}

for (const change of ['headline', 'cta', 'image', 'readiness']) {
  test(`${change} change invalidates prepared JPEG and requires fresh review`, async () => {
    const harness = await creativeReviewHarness();
    await harness.button('Prepare exact JPEG').props.onClick();
    harness.render();
    harness.nodes().find(node => node.props.alt === 'Exact rendered artwork for approval').props.onLoad();
    harness.render();
    assert.equal(harness.button('Approve rendered JPEG').props.disabled, false);
    if (change === 'readiness') harness.props.canReviewExactMetaArtwork = false;
    else harness.nodes().find(node => node.type === ({ headline: 'textarea', cta: 'input', image: 'select' }[change])).props.onChange({ target: { value: change === 'image' ? '' : 'Edited' } });
    harness.render();
    assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
    assert.equal(harness.nodes().some(node => node.props.alt === 'Exact rendered artwork for approval'), false);
    harness.props.canReviewExactMetaArtwork = true;
    harness.render();
    assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
  });
}

test('readiness loss discards an in-flight exact render without losing local edits', async () => {
  let resolvePreview;
  const harness = await creativeReviewHarness({ prepareMetaArtworkReview: () => new Promise(resolve => { resolvePreview = resolve; }) });
  harness.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Keep my local headline' } });
  harness.render();
  harness.button('Prepare exact JPEG').props.onClick();
  harness.props.canReviewExactMetaArtwork = false;
  harness.render();
  resolvePreview({ preparationToken: 'stale', image: { dataUrl: 'data:image/jpeg;base64,AAAA', dimensions: { width: 1080, height: 1350 } } });
  await harness.flush();
  assert.match(harness.text(), /Keep my local headline/);
  assert.equal(harness.nodes().some(node => node.props.alt === 'Exact rendered artwork for approval'), false);
  assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
  assert.equal(harness.button('Prepare exact JPEG').props.disabled, true);
  assert.equal(harness.notices.length, 0);
});
