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

async function creativeReviewHarness(services = {}, initialProps = {}) {
  const slots = [];
  const effects = [];
  const cleanups = [];
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
    useMemo(fn, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index].deps[i]))) slots[index] = { deps, value: fn() };
      return slots[index].value;
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      const changed = !previous || !Array.isArray(deps) || deps.length !== previous.length || deps.some((dep, depIndex) => !Object.is(dep, previous[depIndex]));
      slots[index] = deps;
      if (changed) effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); });
    },
    useSyncExternalStore(_subscribe, getSnapshot) { cursor++; return getSnapshot(); },
    useId() { cursor++; return 'field-id'; },
  };
  const notices = [];
  const saved = [];
  const modules = {
    react: hooks,
    '../../lib/creativeOperations.js': await import('../src/lib/creativeOperations.js'),
    '../../lib/creativeReview.js': await import('../src/lib/creativeReview.js'),
    '../../lib/podRepository.js': { saveCreativeDraft: services.saveCreativeDraft || (async (podId, post, headline, cta, selected, brandName) => ({ id: 'draft-1', pod_id: podId, preference_type: 'creative_review', active: true, created_at: '2026-10-13T20:00:00Z', preference_value: creativeReviewPayload(post.id, headline, cta, selected, false, post.content, { brandName }) })) },
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
    ...initialProps,
  };
  const render = () => { cursor = 0; effects.length = 0; tree = Component(props); effects.splice(0).forEach((effect) => effect()); return tree; };
  const nodes = (node = tree) => typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'object' ? (node.children || []).map(text).join(' ') : String(node);
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node).trim() === label);
  render();
  return { props, render, nodes, text, button, notices, saved, unmount: () => cleanups.forEach(cleanup => cleanup?.()), flush: async () => { await new Promise((resolve) => setImmediate(resolve)); render(); } };
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
    await new Promise(resolve => setImmediate(resolve));
    resolveApproval({ approval: { id: 'old-approval', pod_id: 'pod-1', preference_type: 'creative_review', active: true, created_at: '2026-10-14T10:00:00Z', preference_value: creativeReviewPayload('post-1', 'Fresh caption', '', null, true, 'Fresh caption') }, exports: [{ manifestHash: 'old' }] });
    await harness.flush();
    assert.equal(harness.saved.length, 1, 'reconcile durable approval without approving the changed editor');
    harness.props.savedPreferences = harness.saved; harness.render(); harness.render();
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
  await new Promise(resolve => setImmediate(resolve));
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
  await new Promise(resolve => setImmediate(resolve));
  resolvePreview({ preparationToken: 'stale', image: { dataUrl: 'data:image/jpeg;base64,AAAA', dimensions: { width: 1080, height: 1350 } } });
  await harness.flush();
  assert.match(harness.text(), /Keep my local headline/);
  assert.equal(harness.nodes().some(node => node.props.alt === 'Exact rendered artwork for approval'), false);
  assert.equal(harness.button('Approve rendered JPEG').props.disabled, true);
  assert.equal(harness.button('Prepare exact JPEG').props.disabled, true);
  assert.equal(harness.notices.length, 0);
});

test('disconnected draft save restores headline, CTA and image after remount without approval', async () => {
  const ui = await creativeReviewHarness({}, { canReviewExactMetaArtwork: false, accessToken: undefined });
  for (const [type, value] of [['textarea', 'Saved headline'], ['input', 'Saved CTA'], ['select', '']]) {
    ui.nodes().find(node => node.type === type).props.onChange({ target: { value } }); ui.render();
  }
  await ui.button('Save creative draft').props.onClick(); ui.render();
  assert.match(ui.text(), /Draft saved/);
  assert.equal(ui.saved.length, 1);
  assert.equal(ui.saved[0].preference_value.status, 'draft');
  assert.equal(ui.saved[0].preference_value.approved_at, null);
  ui.unmount();
  const reloaded = await creativeReviewHarness({}, { savedPreferences: ui.saved, canReviewExactMetaArtwork: false });
  assert.equal(reloaded.nodes().find(node => node.type === 'textarea').props.value, 'Saved headline');
  assert.equal(reloaded.nodes().find(node => node.type === 'input').props.value, 'Saved CTA');
  assert.equal(reloaded.nodes().find(node => node.type === 'select').props.value, '');
  assert.match(reloaded.text(), /Draft saved/);
  assert.equal(reloaded.button('Approve rendered JPEG').props.disabled, true);
  for (const props of [{ podId: 'other-pod' }, { post: { id: 'other-post', content: 'Other caption' } }]) {
    const other = await creativeReviewHarness({}, { savedPreferences: ui.saved, ...props });
    assert.doesNotMatch(other.text(), /Saved headline|Saved CTA|Draft saved/);
  }
});

test('stale save reconciles durable revision but does not mark changed caption saved', async () => {
  let finish, calls = 0;
  const ui = await creativeReviewHarness({ saveCreativeDraft: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = ui.button('Save creative draft').props.onClick();
  ui.button('Save creative draft').props.onClick();
  await ui.button('Prepare exact JPEG').props.onClick();
  ui.props.post = { ...ui.props.post, content: 'Changed during save' }; ui.render();
  const row = { id: 'confirmed-old-caption-draft' };
  finish(row); await pending; ui.render();
  assert.equal(calls, 1);
  assert.deepEqual(ui.saved, [row]);
  assert.match(ui.text(), /Unsaved draft/);
  assert.equal(ui.notices.length, 0);
});

test('late save after editor unmount reconciles parent but suppresses child notices', async () => {
  let finish;
  const old = await creativeReviewHarness({ saveCreativeDraft: () => new Promise(resolve => { finish = resolve; }) });
  const pending = old.button('Save creative draft').props.onClick();
  old.unmount();
  const other = await creativeReviewHarness({}, { podId: 'pod-2' });
  finish({ id: 'pod-1-draft' }); await pending;
  assert.deepEqual(old.saved, [{ id: 'pod-1-draft' }]); assert.equal(old.notices.length, 0);
  assert.equal(other.saved.length, 0); assert.doesNotMatch(other.text(), /Draft saved/);
});

test('failed draft save remains unsaved and invalidates previously prepared artwork', async () => {
  const ui = await creativeReviewHarness({ saveCreativeDraft: async () => { throw new Error('Owner-scoped write denied'); } });
  await ui.button('Prepare exact JPEG').props.onClick(); ui.render();
  ui.nodes().find(node => node.props.alt === 'Exact rendered artwork for approval').props.onLoad(); ui.render();
  assert.equal(ui.button('Approve rendered JPEG').props.disabled, false);
  await ui.button('Save creative draft').props.onClick(); ui.render();
  assert.match(ui.text(), /Owner-scoped write denied/);
  assert.match(ui.text(), /Unsaved draft/);
  assert.equal(ui.saved.length, 0);
  assert.equal(ui.button('Approve rendered JPEG').props.disabled, true);
});

test('review restoration uses server timestamp precision and ID ordering, never response order', () => {
  const row = (id, created_at, status) => ({ id, created_at, pod_id: 'p', preference_type: 'creative_review', active: true, preference_value: { post_id: 'post', status } });
  for (const values of [
    [row('b', '2026-10-13T12:00:00.123456Z', 'approved'), row('a', '2026-10-13T12:00:00.123457Z', 'draft')],
    [row('a', '2026-10-13T12:00:00.123456Z', 'approved'), row('b', '2026-10-13T14:00:00.123456+02:00', 'draft')],
  ]) {
    assert.equal(latestCreativeReview(values, 'p', 'post').status, 'draft');
    assert.equal(latestCreativeReview([...values].reverse(), 'p', 'post').status, 'draft');
  }
});

test('remounted clean editor hydrates late saved draft without overwriting newer local edits', async () => {
  const row = { id: 'late-draft', pod_id: 'pod-1', active: true, preference_type: 'creative_review', created_at: '2026-10-13T22:00:00Z', preference_value: creativeReviewPayload('post-1', 'Late saved headline', 'Late CTA', null, false, 'Fresh caption') };
  for (const dirty of [false, true]) {
    const ui = await creativeReviewHarness();
    if (dirty) { ui.nodes().find(node => node.type === 'textarea').props.onChange({target:{value:'Newer local headline'}}); ui.render(); }
    ui.props.savedPreferences = [row]; ui.render(); ui.render(); ui.render();
    assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, dirty ? 'Newer local headline' : 'Late saved headline');
    assert.match(ui.text(), dirty ? /Unsaved draft/ : /Draft saved/);
  }
});

test('restored JSON-string draft can prepare exact artwork without hydration clearing the render', async () => {
  const draft = creativeReviewPayload('post-1', 'Restored headline', '', null, false, 'Fresh caption');
  const ui = await creativeReviewHarness({}, { savedPreferences: [{ id: 'draft-json', pod_id: 'pod-1', active: true, preference_type: 'creative_review', created_at: '2026-10-13T20:00:00Z', preference_value: JSON.stringify(draft) }] });
  ui.render();
  await ui.button('Prepare exact JPEG').props.onClick(); ui.render(); ui.render();
  const image = ui.nodes().find(node => node.props.alt === 'Exact rendered artwork for approval');
  assert.ok(image); image.props.onLoad(); ui.render();
  assert.equal(ui.button('Approve rendered JPEG').props.disabled, false);
});

for (const format of ['object', 'json-string']) {
  test(`unrelated preference saves preserve prepared JPEG for ${format} review rows`, async () => {
    const payload = creativeReviewPayload('post-1', 'Restored headline', '', null, false, 'Fresh caption');
    const row = { id: 'review-a', pod_id: 'pod-1', active: true, preference_type: 'creative_review', created_at: '2026-10-13T20:00:00Z', preference_value: format === 'object' ? payload : JSON.stringify(payload) };
    const ui = await creativeReviewHarness({}, { savedPreferences: [row] });
    ui.render();
    await ui.button('Prepare exact JPEG').props.onClick(); ui.render();
    ui.nodes().find(node => node.props.alt === 'Exact rendered artwork for approval').props.onLoad(); ui.render();
    for (let index = 0; index < 3; index++) {
      ui.props.savedPreferences = [...ui.props.savedPreferences, { ...row, id: `unrelated-${index}`, preference_value: JSON.stringify({ ...payload, post_id: 'post-other' }) }];
      ui.render(); ui.render();
      assert.ok(ui.nodes().find(node => node.props.alt === 'Exact rendered artwork for approval'));
      assert.equal(ui.button('Approve rendered JPEG').props.disabled, false);
    }
  });
}

test('pending draft from an unmounted editor blocks newer exact review until it settles', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { persistCreativeDraft } = await import('../src/lib/creativeDraft.js');
  let release, prepareCalls = 0;
  const client = createClient('https://controlled-review-race.example', 'fixture-public-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (_url, options) => {
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify({ id: 'slow-draft', created_at: '2026-10-14T10:00:00Z', ...JSON.parse(options.body) }), { status: 201 });
  } } });
  const old = await creativeReviewHarness({ saveCreativeDraft: (...args) => persistCreativeDraft(client, ...args) });
  const pending = old.button('Save creative draft').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); old.unmount();
  const fresh = await creativeReviewHarness({ prepareMetaArtworkReview: async () => { prepareCalls++; return {}; } });
  try {
    await fresh.button('Prepare exact JPEG').props.onClick();
    assert.equal(prepareCalls, 0, 'remount must not bypass a pending draft write');
  } finally { release(); await pending; }
});

test('pending approval survives remount and blocks draft handler until durable approval reconciles', async () => {
  let finish, draftCalls=0;
  const old = await creativeReviewHarness({approveMetaArtworkReview:()=>new Promise(resolve=>{finish=resolve;})});
  await old.button('Prepare exact JPEG').props.onClick();old.render();
  old.nodes().find(node=>node.props.alt==='Exact rendered artwork for approval').props.onLoad();old.render();
  const pending=old.button('Approve rendered JPEG').props.onClick();
  await new Promise(resolve=>setImmediate(resolve));old.unmount();
  const fresh=await creativeReviewHarness({saveCreativeDraft:async()=>{draftCalls++;}});
  assert.equal(fresh.button('Save creative draft').props.disabled,true);
  await fresh.button('Save creative draft').props.onClick();assert.equal(draftCalls,0);
  const row={id:'late-approval',pod_id:'pod-1',preference_type:'creative_review',active:true,created_at:'2026-10-14T11:00:00Z',preference_value:creativeReviewPayload('post-1','Approved headline','CTA',null,true,'Fresh caption')};
  finish({approval:row,exports:[]});await pending;
  assert.deepEqual(old.saved,[row]);assert.equal(old.notices.some(notice=>notice.startsWith('Creative approved')),false);
  fresh.props.savedPreferences=old.saved;fresh.render();fresh.render();fresh.render();
  assert.match(fresh.text(),/Approved creative/);
  assert.equal(fresh.nodes().find(node=>node.type==='textarea').props.value,'Approved headline');
  assert.equal(fresh.button('Save creative draft').props.disabled,false);
});

test('a new same-post revision invalidates exact render even when its draft payload is identical', async () => {
  const payload=creativeReviewPayload('post-1','Same headline','',null,false,'Fresh caption');
  const row={id:'revision-1',pod_id:'pod-1',preference_type:'creative_review',active:true,created_at:'2026-10-14T11:00:00Z',preference_value:JSON.stringify(payload)};
  const ui=await creativeReviewHarness({}, {savedPreferences:[row]});ui.render();
  await ui.button('Prepare exact JPEG').props.onClick();ui.render();
  ui.nodes().find(node=>node.props.alt==='Exact rendered artwork for approval').props.onLoad();ui.render();
  assert.equal(ui.button('Approve rendered JPEG').props.disabled,false);
  ui.props.savedPreferences=[row,{...row,id:'revision-2',created_at:'2026-10-14T11:01:00Z'}];ui.render();ui.render();
  assert.equal(ui.nodes().some(node=>node.props.alt==='Exact rendered artwork for approval'),false);
  assert.equal(ui.button('Approve rendered JPEG').props.disabled,true);
});
