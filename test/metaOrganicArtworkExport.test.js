import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

import {
  buildMetaOrganicArtworkExportRequest,
  computeMetaOrganicArtworkManifestHash,
  createMetaOrganicCreativeApprovalAttestation,
  createRpcMetaOrganicArtworkExportStore,
  createInMemoryMetaOrganicArtworkExportStore,
  exportApprovedMetaOrganicArtwork,
  normalizeMetaOrganicSourceEvidenceForAttestation,
  prepareMetaOrganicArtworkReviewEvidence,
  renderMetaOrganicArtworkJpeg,
  META_ORGANIC_ARTWORK_RENDERER_VERSION,
  META_ORGANIC_EXPORT_HEIGHT,
  META_ORGANIC_EXPORT_WIDTH,
} from '../api/_lib/metaOrganicArtworkExport.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const now = new Date('2026-10-12T04:00:00.000Z');
process.env.META_ARTWORK_REVIEW_TOKEN_SECRET = process.env.META_ARTWORK_REVIEW_TOKEN_SECRET || 'test-artwork-review-secret';
const userId = 'user-export-1';
const podId = 'pod-export-1';
const postId = 'post-export-1';
const approvalId = 'approval-export-1';
const accountConnectionId = 'facebook-connection-export-1';
const providerAccountId = '101';

async function fixtureImage() {
  return sharp({
    create: {
      width: 900,
      height: 600,
      channels: 3,
      background: { r: 38, g: 82, b: 111 },
    },
  })
    .composite([{ input: Buffer.from('<svg width="900" height="600" xmlns="http://www.w3.org/2000/svg"><rect x="80" y="80" width="740" height="440" fill="#f3c766"/><text x="140" y="330" font-family="Arial" font-size="74" fill="#172033">SYNTHETIC ASSET</text></svg>'), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

function request(overrides = {}) {
  return buildMetaOrganicArtworkExportRequest({
    userId,
    podId,
    postId,
    provider: 'facebook',
    accountConnectionId,
    providerAccountId,
    approvalId,
    ...overrides,
  });
}

function context(overrides = {}) {
  const caption = overrides.caption || 'Approved caption for a real composition snapshot.';
  const image = overrides.image === undefined ? { kind: 'upload', storage_path: `${userId}/${podId}/asset-a.png` } : overrides.image;
  const preparedPayload = overrides.preparedPayload;
  const sourceHash = overrides.sourceBytes ? crypto.createHash('sha256').update(overrides.sourceBytes).digest('hex') : overrides.sourceHash;
  const sourceEvidence = overrides.sourceEvidence === undefined
    ? (image ? { kind: image.kind, storage_path: image.storage_path, url: image.url, source_url: image.source_url || null, hash: sourceHash, object_version: 'object-version-a', revision: 'source-revision-a', media_type: 'image/png', byte_length: overrides.sourceBytes?.byteLength || 0 } : { kind: 'typography_only', identity: 'typography-only' })
    : overrides.sourceEvidence;
  const value = {
    request: request(overrides.request),
    pod: { brand_name: 'Dovroyn Synthetic' },
    post: {
      id: postId,
      userId,
      podId,
      platform: 'facebook',
      status: 'scheduled',
      body: caption,
      ...overrides.post,
    },
    approvalRow: {
      id: approvalId,
      pod_id: podId,
      preference_type: 'creative_review',
      active: true,
      created_at: '2026-10-12T03:00:00.000Z',
      preference_value: preparedPayload || {
        post_id: postId,
        headline: overrides.headline || 'A clear visual offer with durable provenance',
        call_to_action: overrides.cta || 'Learn more',
        content_snapshot: caption,
        status: 'approved',
        approved_at: '2026-10-12T03:10:00.000Z',
        image,
        artwork_contract_version: 'meta_organic_creative_composition_v2',
        composition: {
          version: 'meta_organic_creative_composition_v2',
          layout: 'meta-organic-portrait-v1',
          font_contract: 'system-ui-safe-v1',
          brand_name: 'Dovroyn Synthetic',
          image_role: image ? 'image' : 'typography',
          typography_only: !image,
          headline: overrides.headline || 'A clear visual offer with durable provenance',
          call_to_action: overrides.cta || 'Learn more',
        },
        source_evidence: sourceEvidence,
        ...overrides.approval,
      },
      ...overrides.approvalRow,
    },
    account: {
      provider: 'facebook',
      accountConnectionId,
      providerAccountId,
      accountLabel: 'Main Page',
      ...overrides.account,
    },
    assets: overrides.assets === undefined ? [{
      storagePath: `${userId}/${podId}/asset-a.png`,
      type: 'image/png',
      assetRole: 'campaign_asset',
      user_id: userId,
      pod_id: podId,
    }] : overrides.assets,
    sourceMedia: overrides.sourceMedia || [],
  };
  const approval = value.approvalRow.preference_value;
  if (approval.status === 'approved' && !approval.server_attestation && approval.final_render_evidence) {
    const contentVersion = crypto.createHash('md5').update(String(value.post.body)).digest('hex');
    const contentHash = crypto.createHash('sha256').update(Buffer.from(value.post.body)).digest('hex');
    const sourceEvidence = normalizeMetaOrganicSourceEvidenceForAttestation(approval.source_evidence || {});
    approval.server_attestation = createMetaOrganicCreativeApprovalAttestation({
      approvalRow: value.approvalRow,
      approval,
      normalized: {
        post: { id: value.post.id, userId: value.post.userId, podId: value.post.podId, provider: value.post.platform, status: value.post.status, caption: value.post.body, contentVersion, contentHash },
        approval: {
          id: value.approvalRow.id,
          rowCreatedAt: value.approvalRow.created_at,
          approvedAt: approval.approved_at,
          contentSnapshot: approval.content_snapshot,
          sourceEvidence,
          finalRenderEvidence: approval.final_render_evidence,
          composition: {
            version: approval.composition.version,
            layout: approval.composition.layout,
            fontContract: approval.composition.font_contract,
            brandName: approval.composition.brand_name,
            imageRole: approval.composition.image_role,
            typographyOnly: approval.composition.typography_only,
            headline: approval.composition.headline,
            callToAction: approval.composition.call_to_action,
          },
        },
      },
      env: process.env,
    });
  }
  return value;
}

async function preparedContext(sourceBytes, overrides = {}) {
  const base = context({ ...overrides, sourceBytes });
  const payload = base.approvalRow.preference_value;
  const prepared = await prepareMetaOrganicArtworkReviewEvidence({
    reviewPayload: payload,
    context: base,
    storage: {
      async readPodAsset() {
        return { bytes: sourceBytes, contentType: 'image/png', objectVersion: 'object-version-a' };
      },
    },
    sourceFetcher: {
      async fetchReviewedSourceImage() {
        return { bytes: sourceBytes, contentType: 'image/png', revision: 'source-revision-a' };
      },
    },
  });
  return context({ ...overrides, preparedPayload: prepared.reviewPayload, sourceBytes });
}

function memoryStorage({ sourceBytes, failPut = false, failManifest = false, signedUrlTtlSeconds = 14_400 } = {}) {
  const objects = new Map();
  const puts = [];
  return {
    objects,
    puts,
    async readPodAsset({ storagePath }) {
      assert.equal(storagePath, `${userId}/${podId}/asset-a.png`);
      return { bytes: sourceBytes, contentType: 'image/png' };
    },
    async putImmutableObject(path, bytes, options) {
      puts.push({ path, bytes, options });
      if (failPut) throw Object.assign(new Error('upload failed'), { code: 'UPLOAD_FAILED' });
      if (objects.has(path)) throw Object.assign(new Error('immutable overwrite'), { code: 'IMMUTABLE_OVERWRITE' });
      objects.set(path, Buffer.from(bytes));
      return { path };
    },
    async createReadOnlySignedUrl(path, ttlSeconds) {
      return {
        url: `https://cdn.example.test/${encodeURIComponent(path)}?signature=synthetic`,
        expiresAt: new Date(now.getTime() + (signedUrlTtlSeconds || ttlSeconds) * 1000).toISOString(),
      };
    },
    failManifest,
  };
}

function storeWithManifestFailure(contexts, storage) {
  const inner = createInMemoryMetaOrganicArtworkExportStore(contexts);
  return {
    manifests: inner.manifests,
    loadApprovedArtworkContext: inner.loadApprovedArtworkContext,
    async persistExportManifest(manifest) {
      if (storage.failManifest) throw Object.assign(new Error('manifest failed'), { code: 'MANIFEST_FAILED' });
      return inner.persistExportManifest(manifest);
    },
  };
}

test('approved artwork renders deterministic JPEG bytes and server manifest with sample inspection', async () => {
  const sourceBytes = await fixtureImage();
  const storage = memoryStorage({ sourceBytes });
  const store = createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes)]);
  const first = await exportApprovedMetaOrganicArtwork({ request: request(), store, storage, now });
  const second = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes)]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });

  assert.equal(first.manifest.output.hash, second.manifest.output.hash);
  assert.equal(first.manifest.manifestHash, second.manifest.manifestHash);
  assert.equal(first.manifest.authority.userId, userId);
  assert.equal(first.manifest.authority.podId, podId);
  assert.equal(first.manifest.authority.postId, postId);
  assert.equal(first.manifest.authority.accountConnectionId, accountConnectionId);
  assert.equal(first.manifest.authority.providerAccountId, providerAccountId);
  assert.equal(first.manifest.authority.creativeApprovalId, approvalId);
  assert.equal(first.manifest.authority.approvalId, undefined);
  assert.equal(first.manifest.authority.rendererVersion, META_ORGANIC_ARTWORK_RENDERER_VERSION);
  assert.equal(first.manifest.source.identity, `${userId}/${podId}/asset-a.png`);
  assert.match(first.manifest.output.objectPath, /^meta-organic-exports\/user-export-1\/pod-export-1\/post-export-1\/approval-export-1\/facebook-connection-export-1\/[a-f0-9]{64}\.jpg$/);
  assert.equal(first.manifest.output.mediaType, 'image/jpeg');
  assert.equal(first.manifest.output.dimensions.width, META_ORGANIC_EXPORT_WIDTH);
  assert.equal(first.manifest.output.dimensions.height, META_ORGANIC_EXPORT_HEIGHT);

  const meta = await sharp(first.bytes).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, META_ORGANIC_EXPORT_WIDTH);
  assert.equal(meta.height, META_ORGANIC_EXPORT_HEIGHT);
  const samplePath = new URL('../docs/meta-organic-artwork-sample.jpg', import.meta.url);
  await mkdir(dirname(samplePath.pathname), { recursive: true });
  await writeFile(samplePath, first.bytes);
});

test('server preparation freezes actual upload bytes before renewed rendered-artwork review', async () => {
  const sourceBytes = await fixtureImage();
  const unpinned = context({ sourceBytes: null });
  delete unpinned.approvalRow.preference_value.source_evidence;
  delete unpinned.approvalRow.preference_value.final_render_evidence;
  const blocked = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([unpinned]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(blocked.reason, 'EXPORT_SOURCE_EVIDENCE_REQUIRED');

  const base = context({
    sourceBytes: null,
    assets: [{
      storagePath: `${userId}/${podId}/asset-a.png`,
      media_type: 'image/png',
      file_size: sourceBytes.byteLength,
      assetRole: 'campaign_asset',
      pod_id: podId,
    }],
  });
  const prepared = await prepareMetaOrganicArtworkReviewEvidence({
    reviewPayload: base.approvalRow.preference_value,
    context: base,
    storage: { async readPodAsset() { return { bytes: sourceBytes, contentType: 'image/png', objectVersion: 'object-version-a' }; } },
  });
  assert.equal(prepared.reviewPayload.source_evidence.hash, crypto.createHash('sha256').update(sourceBytes).digest('hex'));
  assert.equal(prepared.reviewPayload.source_evidence.object_version, 'object-version-a');
  assert.equal(prepared.reviewPayload.final_render_evidence.rendererVersion, META_ORGANIC_ARTWORK_RENDERER_VERSION);
  const renewed = context({ preparedPayload: prepared.reviewPayload, sourceBytes });
  const exported = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([renewed]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(exported.status, 'exported');
});

test('typography-only, portrait and landscape compositions render explicitly', async () => {
  const portrait = await renderMetaOrganicArtworkJpeg({ headline: 'Portrait crop', callToAction: 'Book now', caption: 'Long copy '.repeat(40), sourceImageBytes: await sharp({ create: { width: 600, height: 1200, channels: 3, background: '#b03a2e' } }).png().toBuffer() });
  const landscape = await renderMetaOrganicArtworkJpeg({ headline: 'Landscape crop', callToAction: 'Start', caption: 'Landscape approved caption', sourceImageBytes: await sharp({ create: { width: 1400, height: 600, channels: 3, background: '#2e7d5b' } }).png().toBuffer() });
  const typography = await renderMetaOrganicArtworkJpeg({ headline: 'Typography only design', callToAction: '', caption: 'No image is approved, so the contract renders a text-only layout.', sourceImageBytes: null });
  for (const bytes of [portrait, landscape, typography]) {
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, META_ORGANIC_EXPORT_WIDTH);
    assert.equal(meta.height, META_ORGANIC_EXPORT_HEIGHT);
  }
});

test('tenant, approval version and account-target mismatches are blocked before byte writes', async () => {
  const sourceBytes = await fixtureImage();
  const good = await preparedContext(sourceBytes);
  for (const bad of [
    { ...good, post: { ...good.post, userId: 'other-user' } },
    { ...good, approvalRow: { ...good.approvalRow, preference_value: { ...good.approvalRow.preference_value, content_snapshot: 'stale caption' } } },
    { ...good, account: { ...good.account, providerAccountId: '201' } },
    { ...good, assets: [] },
  ]) {
    const storage = memoryStorage({ sourceBytes });
    const result = await exportApprovedMetaOrganicArtwork({
      request: request(),
      store: createInMemoryMetaOrganicArtworkExportStore([bad]),
      storage,
      now,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(storage.puts.length, 0);
  }
});

test('browser-forged creative approval evidence without server attestation cannot export', async () => {
  const sourceBytes = await fixtureImage();
  const forged = await preparedContext(sourceBytes);
  delete forged.approvalRow.preference_value.server_attestation;
  const storage = memoryStorage({ sourceBytes });
  const result = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([forged]),
    storage,
    now,
  });
  assert.equal(result.reason, 'EXPORT_APPROVAL_ATTESTATION_REQUIRED');
  assert.equal(storage.puts.length, 0);
});

test('newer draft review supersedes older approved export and manifest tampering is rejected', async () => {
  const sourceBytes = await fixtureImage();
  const approved = await preparedContext(sourceBytes);
  approved.latestApprovalRow = {
    id: 'newer-draft-review',
    pod_id: podId,
    preference_type: 'creative_review',
    active: true,
    created_at: '2026-10-12T03:30:00.000Z',
    preference_value: { post_id: postId, status: 'draft', content_snapshot: approved.post.body },
  };
  const superseded = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([approved]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(superseded.reason, 'EXPORT_APPROVAL_SUPERSEDED');

  const current = await preparedContext(sourceBytes);
  const store = createInMemoryMetaOrganicArtworkExportStore([current]);
  const exported = await exportApprovedMetaOrganicArtwork({ request: request(), store, storage: memoryStorage({ sourceBytes }), now });
  for (const mutate of [
    (manifest) => { manifest.authority.postId = 'other-post'; },
    (manifest) => { manifest.output.hash = 'b'.repeat(64); },
    (manifest) => { manifest.output.objectPath = manifest.output.objectPath.replace('/post-export-1/', '/other-post/'); },
    (manifest) => { manifest.composition.layout = 'other-layout'; },
  ]) {
    const tampered = structuredClone(exported.manifest);
    mutate(tampered);
    await assert.rejects(() => store.persistExportManifest(tampered), /EXPORT_MANIFEST_|EXPORT_TENANT|EXPORT_CONTEXT|EXPORT_APPROVAL/);
  }
});

test('caption body is compared and hashed exactly, without silent trim or truncation', async () => {
  const sourceBytes = await fixtureImage();
  const exactCaption = '  Exact approved body with intentional spaces  ';
  const result = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes, { caption: exactCaption })]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(result.status, 'exported');
  assert.equal(result.manifest.composition.captionSnapshot, exactCaption);

  const staleContext = await preparedContext(sourceBytes, { caption: exactCaption });
  staleContext.approvalRow.preference_value.content_snapshot = exactCaption.trim();
  const stale = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([staleContext]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(stale.reason, 'EXPORT_APPROVAL_STALE');

  const tooLong = await exportApprovedMetaOrganicArtwork({
    request: request({ provider: 'instagram', account: { provider: 'instagram', providerAccountId: '201', accountConnectionId: accountConnectionId } }),
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes, {
      caption: 'x'.repeat(2201),
      request: { provider: 'instagram', providerAccountId: '201' },
      post: { platform: 'instagram' },
      account: { provider: 'instagram', providerAccountId: '201' },
    })]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(tooLong.reason, 'EXPORT_CAPTION_TOO_LONG');
});

test('one creative approval can export distinct account-bound manifests without publishing approval creation', async () => {
  const sourceBytes = await fixtureImage();
  const first = await exportApprovedMetaOrganicArtwork({
    request: request({ accountConnectionId: 'facebook-connection-a', providerAccountId: '101' }),
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes, {
      request: { accountConnectionId: 'facebook-connection-a', providerAccountId: '101' },
      account: { accountConnectionId: 'facebook-connection-a', providerAccountId: '101' },
    })]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  const second = await exportApprovedMetaOrganicArtwork({
    request: request({ accountConnectionId: 'facebook-connection-b', providerAccountId: '201' }),
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes, {
      request: { accountConnectionId: 'facebook-connection-b', providerAccountId: '201' },
      account: { accountConnectionId: 'facebook-connection-b', providerAccountId: '201' },
    })]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(first.status, 'exported');
  assert.equal(second.status, 'exported');
  assert.equal(first.manifest.authority.creativeApprovalId, approvalId);
  assert.equal(second.manifest.authority.creativeApprovalId, approvalId);
  assert.notEqual(first.manifest.manifestHash, second.manifest.manifestHash);
  assert.equal(first.manifest.authority.publishApprovalId, undefined);
  assert.equal(second.manifest.authority.publishApprovalId, undefined);
});

test('persisted target snapshot resolves server-side connection id without retargeting to defaults', async () => {
  const sourceBytes = await fixtureImage();
  const requested = request({ accountConnectionId: undefined, account: { provider: 'facebook', providerAccountId: '101', accountLabel: 'Main Page' } });
  const exported = await exportApprovedMetaOrganicArtwork({
    request: requested,
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes)]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(exported.status, 'exported');
  assert.equal(exported.manifest.authority.accountConnectionId, accountConnectionId);

  const tampered = await exportApprovedMetaOrganicArtwork({
    request: request({ accountConnectionId: undefined, account: { provider: 'facebook', providerAccountId: '999', accountLabel: 'Other Page' } }),
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes)]),
    storage: memoryStorage({ sourceBytes }),
    now,
  });
  assert.equal(tampered.reason, 'EXPORT_CONTEXT_UNAVAILABLE');
});


test('reviewed source image must match source media and internal URLs are rejected', async () => {
  const sourceBytes = await fixtureImage();
  const reviewed = await preparedContext(sourceBytes, {
    image: { kind: 'source', url: 'https://assets.example.test/photo.jpg', source_url: 'https://example.test/' },
    assets: [],
    sourceMedia: [{ url: 'https://assets.example.test/photo.jpg', source_url: 'https://example.test/', role: 'source_image', approval_status: 'needs_review' }],
  });
  const fetches = [];
  const result = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([reviewed]),
    storage: memoryStorage({ sourceBytes }),
    sourceFetcher: { async fetchReviewedSourceImage(input) { fetches.push(input); return { bytes: sourceBytes, contentType: 'image/png', revision: 'source-revision-a' }; } },
    now,
  });
  assert.equal(result.status, 'exported');
  assert.equal(fetches.length, 1);

  const unreviewed = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([await preparedContext(sourceBytes, {
      image: { kind: 'source', url: 'https://assets.example.test/other.jpg', source_url: 'https://example.test/' },
      assets: [],
      sourceMedia: [],
    })]),
    storage: memoryStorage({ sourceBytes }),
    sourceFetcher: { async fetchReviewedSourceImage() { assert.fail('unreviewed source must not fetch'); } },
    now,
  });
  assert.equal(unreviewed.reason, 'EXPORT_SOURCE_NOT_APPROVED');

  const internal = await exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([context({
      image: { kind: 'source', url: 'http://127.0.0.1/private.jpg', source_url: 'http://127.0.0.1/' },
      assets: [],
      sourceMedia: [{ url: 'http://127.0.0.1/private.jpg', source_url: 'http://127.0.0.1/', role: 'source_image', approval_status: 'needs_review' }],
    })]),
    storage: memoryStorage({ sourceBytes }),
    sourceFetcher: { async fetchReviewedSourceImage() { assert.fail('internal source must not fetch'); } },
    now,
  });
  assert.equal(internal.reason, 'EXPORT_SOURCE_URL_INVALID');
});

test('hostile image bytes, upload failure, manifest failure, overwrite refusal and short expiry are not publishable exports', async () => {
  const sourceBytes = await fixtureImage();
  const prepared = await preparedContext(sourceBytes);
  await assert.rejects(() => exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([prepared]),
    storage: memoryStorage({ sourceBytes: Buffer.from('not-an-image') }),
    now,
  }), /Input buffer contains unsupported image format|Artwork source image|source bytes changed/i);

  await assert.rejects(() => exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([prepared]),
    storage: memoryStorage({ sourceBytes, failPut: true }),
    now,
  }), /upload failed/);

  const partialStorage = memoryStorage({ sourceBytes, failManifest: true });
  await assert.rejects(() => exportApprovedMetaOrganicArtwork({
    request: request(),
    store: storeWithManifestFailure([prepared], partialStorage),
    storage: partialStorage,
    now,
  }), /manifest failed/);
  assert.equal(partialStorage.puts.length, 1);

  const firstStore = createInMemoryMetaOrganicArtworkExportStore([prepared]);
  const firstStorage = memoryStorage({ sourceBytes });
  await exportApprovedMetaOrganicArtwork({ request: request(), store: firstStore, storage: firstStorage, now });
  await assert.rejects(() => exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([prepared]),
    storage: firstStorage,
    now,
  }), /immutable overwrite/);

  await assert.rejects(() => exportApprovedMetaOrganicArtwork({
    request: request(),
    store: createInMemoryMetaOrganicArtworkExportStore([prepared]),
    storage: memoryStorage({ sourceBytes, signedUrlTtlSeconds: 60 }),
    now,
  }), /Provider-readable export URL/);
});


test('signed URL and expiry are bound, and rehashed exports must match the reviewed bytes', async () => {
  const sourceBytes = await fixtureImage();
  const approved = await preparedContext(sourceBytes);
  const exported = await exportApprovedMetaOrganicArtwork({ request: request(), store: createInMemoryMetaOrganicArtworkExportStore([approved]), storage: memoryStorage({ sourceBytes }), now });
  assert.equal(exported.status, 'exported');
  for (const field of ['providerReadableUrl', 'providerReadableUrlExpiresAt']) {
    const changed = structuredClone(exported.manifest);
    changed.output[field] = field === 'providerReadableUrl' ? 'https://other.example.test/replaced.jpg' : '2026-10-13T04:00:00.000Z';
    let calls = 0;
    const rpcStore = createRpcMetaOrganicArtworkExportStore({ rpc: async () => { calls++; } });
    await assert.rejects(() => rpcStore.persistExportManifest(changed), /EXPORT_MANIFEST_HASH_MISMATCH/);
    assert.equal(calls, 0);
  }
  for (const mutate of [
    m => { m.output.hash = 'b'.repeat(64); m.output.objectPath = m.output.objectPath.replace(/[^/]+\.jpg$/, `${m.output.hash}.jpg`); },
    m => { m.output.byteLength++; },
    m => { m.source.objectVersion = 'unapproved-version'; },
    m => { m.composition.headline = 'Unapproved headline'; },
  ]) {
    const changed = structuredClone(exported.manifest);
    mutate(changed);
    changed.manifestHash = computeMetaOrganicArtworkManifestHash(changed);
    await assert.rejects(() => createInMemoryMetaOrganicArtworkExportStore([approved]).persistExportManifest(changed), /EXPORT_CONTEXT_CHANGED/);
  }
  const changedApproval = structuredClone(approved);
  changedApproval.approvalRow.preference_value.final_render_evidence.hash = 'c'.repeat(64);
  await assert.rejects(() => createInMemoryMetaOrganicArtworkExportStore([changedApproval]).persistExportManifest(exported.manifest), /EXPORT_APPROVAL_ATTESTATION_REQUIRED/);
});
