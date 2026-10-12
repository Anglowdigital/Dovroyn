import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approveArtworkReviewAndExport, prepareArtworkReview } from '../api/_lib/metaOrganicArtworkReview.js';
import { createInMemoryMetaOrganicArtworkExportStore } from '../api/_lib/metaOrganicArtworkExport.js';

const env = {
  ...process.env,
  VITE_SUPABASE_URL: 'https://supabase.test',
  VITE_SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  META_ARTWORK_REVIEW_TOKEN_SECRET: 'review-secret-for-tests',
};
const imageBytes = readFileSync(new URL('../docs/meta-organic-artwork-sample.jpg', import.meta.url));
const user = { id: 'user-review-1' };
const podId = 'pod-review-1';
const postId = 'post-review-1';
const uploadPath = `${user.id}/${podId}/image.jpg`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function createRestHarness({ otherPreferenceCount = 0, schemaAvailable = true, transformConnections = (rows) => rows } = {}) {
  const rows = {
    pod: { id: podId, user_id: user.id, pod_name: 'Review Pod', brand_name: 'Review Brand', status: 'active' },
    post: { id: postId, pod_id: podId, platform: 'facebook', status: 'draft', body: 'Approved caption', updated_at: '2026-10-12T00:00:00Z' },
    asset: { id: 'asset-1', pod_id: podId, storage_path: uploadPath, media_type: 'image/jpeg', file_size: imageBytes.byteLength, asset_role: 'campaign_asset', file_name: 'image.jpg', created_at: '2026-10-12T00:00:00Z' },
    snapshot: {
      id: 'snapshot-1',
      pod_id: podId,
      preference_type: 'social_post_target_snapshot',
      active: true,
      created_at: '2026-10-10T00:00:00Z',
      preference_value: {
        postId,
        platform: 'facebook',
        targets: [
          { provider: 'facebook', providerAccountId: '101', accountLabel: 'Main Page' },
          { provider: 'facebook', providerAccountId: '201', accountLabel: 'Second Page' },
        ],
      },
    },
    approvalRows: [],
  };
  const calls = [];
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url: url.toString(), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url.pathname === '/rest/v1/pods') return json([rows.pod]);
    if (url.pathname === '/rest/v1/social_posts' && (options.method || 'GET') === 'GET') return json([rows.post]);
    if (url.pathname === '/rest/v1/social_posts' && options.method === 'PATCH') {
      rows.post = { ...rows.post, ...JSON.parse(options.body) };
      return json([rows.post]);
    }
    if (url.pathname === '/rest/v1/pod_assets') return json([rows.asset]);
    if (url.pathname === '/rest/v1/pod_preferences' && (options.method || 'GET') === 'GET') {
      const query = decodeURIComponent(url.search);
      if (query.includes('preference_type=eq.website_intelligence')) return json([]);
      if (query.includes('preference_type=eq.creative_review')) {
        const unrelated = Array.from({ length: otherPreferenceCount }, (_, index) => ({
          id: `other-${index}`,
          pod_id: podId,
          preference_type: 'creative_review',
          active: true,
          created_at: `2026-10-09T00:${String(index).padStart(2, '0')}:00Z`,
          preference_value: { post_id: `other-post-${index}`, status: 'approved' },
        }));
        return json([...unrelated, ...rows.approvalRows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
      }
      if (query.includes('preference_type=eq.social_post_target_snapshot')) return json([rows.snapshot]);
      return json([]);
    }
    if (url.pathname === '/rest/v1/pod_preferences' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      const row = {
        id: `approval-${rows.approvalRows.length + 1}`,
        pod_id: body.pod_id,
        preference_type: body.preference_type,
        preference_value: body.preference_value,
        source: body.source,
        active: body.active,
        created_at: '2026-10-12T01:00:00Z',
      };
      rows.approvalRows.unshift(row);
      return json([row]);
    }
    if (url.pathname === '/rest/v1/pod_preferences' && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      rows.approvalRows[0] = { ...rows.approvalRows[0], ...body, preference_value: body.preference_value, updated_at: body.updated_at };
      return json([rows.approvalRows[0]]);
    }
    if (url.pathname === '/rest/v1/rpc/list_meta_organic_connections') {
      return json(transformConnections([
        { id: 'conn-101', provider: 'facebook', providerAccountId: '101', provider_account_id: '101', accountLabel: 'Main Page', account_label: 'Main Page', status: 'connected', expires_at: '2099-01-01T00:00:00Z', provider_verified_source: 'meta_organic_server_v1', provider_contract_version: 'meta_organic_facebook_login_selection_v2' },
        { id: 'conn-201', provider: 'facebook', providerAccountId: '201', provider_account_id: '201', accountLabel: 'Second Page', account_label: 'Second Page', status: 'connected', expires_at: '2099-01-01T00:00:00Z', provider_verified_source: 'meta_organic_server_v1', provider_contract_version: 'meta_organic_facebook_login_selection_v2' },
      ]));
    }
    if (url.pathname === '/rest/v1/rpc/persist_meta_organic_creative_approval_attestation') {
      if (!schemaAvailable) return json({ message: 'function persist_meta_organic_creative_approval_attestation does not exist' }, 404);
      rows.persistedAttestation = JSON.parse(options.body).p_attestation;
      return json({ ok: true });
    }
    throw new Error(`Unhandled fetch ${options.method || 'GET'} ${url.pathname} ${url.search}`);
  };
  return { rows, calls, fetchImpl };
}

function restoreEnv(originalEnv) {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(originalEnv, key)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

test('prepare blocks nonmember uploads before storage reads', async (t) => {
  const harness = createRestHarness();
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  globalThis.fetch = harness.fetchImpl;
  Object.assign(process.env, env);
  t.after(() => { globalThis.fetch = originalFetch; restoreEnv(originalEnv); });
  let reads = 0;
  await assert.rejects(() => prepareArtworkReview({
    accessToken: 'token',
    user,
    input: { podId, postId, headline: 'Headline', image: { kind: 'upload', storage_path: `${user.id}/${podId}/missing.png` } },
    storage: { async readPodAsset() { reads += 1; return { bytes: imageBytes, contentType: 'image/jpeg', objectVersion: 'v1' }; } },
    env,
  }), /Choose an image from this pod/);
  assert.equal(reads, 0);
});

test('prepare blocks unsupported providers and missing account targets before storage or approval writes', async (t) => {
  for (const scenario of ['non_meta_provider', 'missing_targets']) {
    const harness = createRestHarness();
    if (scenario === 'non_meta_provider') {
      harness.rows.post.platform = 'linkedin';
      harness.rows.snapshot.preference_value.platform = 'linkedin';
      harness.rows.snapshot.preference_value.targets = [{ provider: 'linkedin', providerAccountId: '301', accountLabel: 'Company Page' }];
    } else {
      harness.rows.snapshot.preference_value.targets = [];
    }
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    globalThis.fetch = harness.fetchImpl;
    Object.assign(process.env, env);
    let reads = 0;
    try {
      await assert.rejects(() => prepareArtworkReview({
        accessToken: 'token',
        user,
        input: { podId, postId, headline: 'Release check', image: { kind: 'upload', storage_path: uploadPath } },
        storage: { async readPodAsset() { reads += 1; return { bytes: imageBytes, contentType: 'image/jpeg', objectVersion: 'v1' }; } },
        env,
      }), (error) => scenario === 'non_meta_provider'
        ? error.code === 'ARTWORK_PROVIDER_UNSUPPORTED'
        : error.code === 'ARTWORK_TARGETS_REQUIRED');
      assert.equal(reads, 0);
      assert.equal(harness.rows.approvalRows.length, 0);
      assert.equal(harness.calls.some((call) => (call.url.includes('/rest/v1/social_posts') && call.method === 'PATCH')
        || (call.url.includes('/rest/v1/pod_preferences') && ['PATCH', 'POST'].includes(call.method))), false);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv(originalEnv);
    }
  }
});

test('authenticated prepare then explicit approval exports per saved account and reports partial failure', async (t) => {
  const harness = createRestHarness({ otherPreferenceCount: 30 });
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  globalThis.fetch = harness.fetchImpl;
  Object.assign(process.env, env);
  t.after(() => { globalThis.fetch = originalFetch; restoreEnv(originalEnv); });
  const storage = {
    async readPodAsset({ storagePath }) {
      assert.equal(storagePath, uploadPath);
      return { bytes: imageBytes, contentType: 'image/jpeg', objectVersion: 'object-v1' };
    },
    async putImmutableObject(path, bytes) {
      assert.match(path, /^meta-organic-exports\/user-review-1\/pod-review-1\/post-review-1\/approval-1\/conn-(101|201)\//);
      if (path.includes('/conn-201/')) throw Object.assign(new Error('storage unavailable'), { code: 'EXPORT_STORAGE_UNAVAILABLE' });
      this.lastBytes = Buffer.from(bytes);
    },
    async createReadOnlySignedUrl(path) {
      return { url: `https://cdn.example/${encodeURIComponent(path)}`, expiresAt: '2099-01-01T00:00:00Z' };
    },
  };
  const prepared = await prepareArtworkReview({
    accessToken: 'token',
    user,
    input: { podId, postId, headline: 'Review headline', callToAction: 'Learn more', image: { kind: 'upload', storage_path: uploadPath } },
    storage,
    now: Date.parse('2026-10-12T01:00:00Z'),
    env,
  });
  assert.match(prepared.image.dataUrl, /^data:image\/jpeg;base64,/);
  assert.match(prepared.accountSnapshotFingerprint, /^[a-f0-9]{64}$/);
  const store = {
    async loadApprovedArtworkContext(request) {
      const approvalRow = harness.rows.approvalRows[0];
      return {
        post: { id: postId, userId: user.id, podId, platform: 'facebook', status: harness.rows.post.status, body: harness.rows.post.body },
        approvalRow,
        approval: approvalRow.preference_value,
        latestApprovalRow: approvalRow,
        account: { provider: 'facebook', providerAccountId: request.providerAccountId, accountConnectionId: request.accountConnectionId },
        assets: [harness.rows.asset],
        pod: harness.rows.pod,
      };
    },
    async persistExportManifest() {},
  };
  const result = await approveArtworkReviewAndExport({
    accessToken: 'token',
    user,
    input: { podId, postId, preparationToken: prepared.preparationToken, accountSnapshotFingerprint: prepared.accountSnapshotFingerprint },
    storage,
    store,
    now: Date.parse('2026-10-12T01:01:00Z'),
    env,
  });
  assert.equal(result.status, 'partially_exported');
  assert.equal(result.exports.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].accountConnectionId, 'conn-201');
  assert.equal(harness.rows.post.status, 'approved');
  assert.equal(harness.rows.persistedAttestation.approvalId, 'approval-1');
});

test('approval blocks removed account targets before post or approval mutations', async (t) => {
  const harness = createRestHarness();
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  globalThis.fetch = harness.fetchImpl;
  Object.assign(process.env, env);
  t.after(() => { globalThis.fetch = originalFetch; restoreEnv(originalEnv); });
  const storage = { async readPodAsset() { return { bytes: imageBytes, contentType: 'image/jpeg', objectVersion: 'object-v1' }; } };
  const prepared = await prepareArtworkReview({
    accessToken: 'token',
    user,
    input: { podId, postId, headline: 'Review headline', image: { kind: 'upload', storage_path: uploadPath } },
    storage,
    now: Date.parse('2026-10-12T01:00:00Z'),
    env,
  });
  harness.rows.snapshot.preference_value.targets = [];
  await assert.rejects(() => approveArtworkReviewAndExport({
    accessToken: 'token',
    user,
    input: { podId, postId, preparationToken: prepared.preparationToken, accountSnapshotFingerprint: prepared.accountSnapshotFingerprint },
    storage,
    store: createInMemoryMetaOrganicArtworkExportStore([]),
    now: Date.parse('2026-10-12T01:01:00Z'),
    env,
  }), (error) => error.code === 'ARTWORK_TARGETS_REQUIRED');
  assert.equal(harness.rows.post.status, 'draft');
  assert.equal(harness.rows.approvalRows.length, 0);
  assert.equal(harness.rows.persistedAttestation, undefined);
});

test('missing private attestation RPC schema blocks approval without success', async (t) => {
  const harness = createRestHarness({ schemaAvailable: false });
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  globalThis.fetch = harness.fetchImpl;
  Object.assign(process.env, env);
  t.after(() => { globalThis.fetch = originalFetch; restoreEnv(originalEnv); });
  const storage = { async readPodAsset() { return { bytes: imageBytes, contentType: 'image/jpeg', objectVersion: 'object-v1' }; } };
  const prepared = await prepareArtworkReview({
    accessToken: 'token',
    user,
    input: { podId, postId, headline: 'Review headline', image: { kind: 'upload', storage_path: uploadPath } },
    storage,
    now: Date.parse('2026-10-12T01:00:00Z'),
    env,
  });
  await assert.rejects(() => approveArtworkReviewAndExport({
    accessToken: 'token',
    user,
    input: { podId, postId, preparationToken: prepared.preparationToken, accountSnapshotFingerprint: prepared.accountSnapshotFingerprint },
    storage,
    store: createInMemoryMetaOrganicArtworkExportStore([]),
    now: Date.parse('2026-10-12T01:01:00Z'),
    env,
  }), /does not exist|unavailable/i);
  assert.equal(harness.rows.approvalRows[0].active, false);
  assert.equal(harness.rows.approvalRows[0].preference_value.status, 'approval_unavailable');
  assert.equal(harness.rows.persistedAttestation, undefined);
});

for (const scenario of ['missing', 'revoked', 'mismatched_saved_connection', 'wrong_provider', 'saved_target_wrong_provider', 'malformed_target']) {
  test('prepare rejects every unavailable saved account: ' + scenario, async (t) => {
    const harness = createRestHarness({
      transformConnections: (rows) => scenario === 'missing' ? rows.slice(0, 1)
        : scenario === 'revoked' ? rows.map((row) => row.providerAccountId === '201' ? { ...row, status: 'revoked' } : row)
        : scenario === 'wrong_provider' ? rows.map((row) => row.providerAccountId === '201' ? { ...row, provider: 'instagram' } : row)
        : rows,
    });
    if (scenario === 'mismatched_saved_connection') {
      harness.rows.snapshot.preference_value.targets[1].accountConnectionId = 'conn-101';
    } else if (scenario === 'saved_target_wrong_provider') {
      harness.rows.snapshot.preference_value.targets[1].provider = 'linkedin';
    } else if (scenario === 'malformed_target') {
      harness.rows.snapshot.preference_value.targets[1].providerAccountId = '';
    }
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    globalThis.fetch = harness.fetchImpl;
    Object.assign(process.env, env);
    t.after(() => { globalThis.fetch = originalFetch; restoreEnv(originalEnv); });
    let reads = 0;
    await assert.rejects(() => prepareArtworkReview({
      accessToken: 'token', user,
      input: { podId, postId, headline: 'Both selected Pages', image: { kind: 'upload', storage_path: uploadPath } },
      storage: { async readPodAsset() { reads += 1; throw new Error('Should not read source'); } },
      env,
    }), (error) => error.code === 'ARTWORK_TARGET_UNAVAILABLE'
      && (scenario === 'malformed_target' ? error.providerAccountId === '' : error.providerAccountId === '201'));
    assert.equal(reads, 0);
    assert.equal(harness.rows.snapshot.preference_value.targets.length, 2);
    assert.equal(harness.rows.approvalRows.length, 0);
    assert.equal(harness.calls.some((call) => call.method === 'PATCH'), false);
  });
}
