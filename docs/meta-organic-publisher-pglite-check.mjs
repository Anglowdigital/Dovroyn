import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildMetaOrganicPublishProposal,
  createRpcMetaOrganicPublishStore,
  processNextMetaOrganicPublishJob,
  reconcileNextMetaOrganicPublishJob,
} from '../api/_lib/metaOrganicPublisher.js';
import {
  buildMetaOrganicArtworkExportRequest,
  buildMetaOrganicCreativeApprovalAttestationPayload,
  computeMetaOrganicArtworkManifestHash,
  createMetaOrganicCreativeApprovalAttestation,
  createRpcMetaOrganicArtworkExportStore,
  exportApprovedMetaOrganicArtwork,
  normalizeMetaOrganicSourceEvidenceForAttestation,
} from '../api/_lib/metaOrganicArtworkExport.js';

const pgliteModule = process.env.PGLITE_MODULE;
process.env.META_ARTWORK_REVIEW_TOKEN_SECRET ||= 'pglite-local-attestation-secret';
if (!pgliteModule) {
  console.error('PGLITE_MODULE is required. Example: PGLITE_MODULE=/tmp/dovroyn-pr48-sqlcheck/node_modules/@electric-sql/pglite/dist/index.js node docs/meta-organic-publisher-pglite-check.mjs');
  process.exit(1);
}

let PGlite;
try {
  ({ PGlite } = await import(pgliteModule));
} catch (error) {
  console.error(`Unable to import PGlite from PGLITE_MODULE=${pgliteModule}`);
  console.error(error?.message || error);
  process.exit(1);
}

const connectionSql = readFileSync(new URL('../supabase/proposed-migrations/20261012000000_proposed_meta_organic_connection_cutover.sql', import.meta.url), 'utf8');
const publisherSql = readFileSync(new URL('../supabase/proposed-migrations/20261012003000_proposed_meta_organic_publisher_pilot.sql', import.meta.url), 'utf8');
const ids = Object.freeze({
  user: '00000000-0000-4000-8000-000000000001',
  pod: '00000000-0000-4000-8000-000000000002',
  draft: '00000000-0000-4000-8000-000000000003',
  approval: '00000000-0000-4000-8000-000000000004',
  approval2: '00000000-0000-4000-8000-000000000005',
  account: '00000000-0000-4000-8000-000000000006',
  creativeApproval: '00000000-0000-4000-8000-000000000007',
  account2: '00000000-0000-4000-8000-000000000008',
});
const syntheticSourceBytes = Buffer.from('synthetic-source-bytes');
const syntheticSourceHash = crypto.createHash('sha256').update(syntheticSourceBytes).digest('hex');

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function literalJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function proposal(overrides = {}) {
  const body = overrides.body || 'Approved synthetic caption';
  const base = {
    provider: 'facebook',
    userId: ids.user,
    podId: ids.pod,
    draftId: ids.draft,
    accountConnectionId: ids.account,
    contentVersion: crypto.createHash('md5').update(body).digest('hex'),
    approvalId: ids.approval,
    campaignDate: '2026-10-12',
    ...overrides,
  };
  return buildMetaOrganicPublishProposal({
    ...base,
    assetManifestHash: overrides.assetManifestHash || syntheticManifestHash(base),
  });
}

function syntheticManifestHash(p) {
  const outputHash = crypto.createHash('sha256').update('rendered-output-v1').digest('hex');
  return computeMetaOrganicArtworkManifestHash({
    contractVersion: 'meta_organic_artwork_export_v1',
    status: 'exported',
    immutable: true,
    authority: {
      userId: p.userId,
      podId: p.podId,
      postId: p.draftId,
      provider: p.provider,
      accountConnectionId: p.accountConnectionId,
      providerAccountId: p.accountConnectionId === ids.account2 ? '201' : '101',
      creativeApprovalId: ids.creativeApproval,
      approvedAt: '2026-10-11T00:00:00.000Z',
      contentVersion: p.contentVersion,
      contentHash: crypto.createHash('sha256').update('Approved synthetic caption').digest('hex'),
      sourceIdentity: `${ids.user}/${ids.pod}/synthetic-source.jpg`,
      sourceHash: syntheticSourceHash,
      sourceKind: 'upload',
      rendererVersion: 'sharp_svg_jpeg_2026_10_12_v1',
    },
    composition: {
      version: 'meta_organic_creative_composition_v2',
      layout: 'meta-organic-portrait-v1',
      fontContract: 'system-ui-safe-v1',
      brandName: 'Synthetic Pod',
      imageRole: 'image',
      typographyOnly: false,
      headline: 'Synthetic approved headline',
      callToAction: 'Learn more',
      captionSnapshot: 'Approved synthetic caption',
    },
    source: {
      kind: 'upload',
      identity: `${ids.user}/${ids.pod}/synthetic-source.jpg`,
      hash: syntheticSourceHash,
      objectVersion: 'object-version-synthetic',
      mediaType: 'image/jpeg',
      byteLength: syntheticSourceBytes.byteLength,
    },
    output: {
      hash: outputHash,
      mediaType: 'image/jpeg',
      dimensions: { width: 1080, height: 1350 },
      byteLength: 1000,
      objectPath: `meta-organic-exports/${p.userId}/${p.podId}/${p.draftId}/${ids.creativeApproval}/${p.accountConnectionId}/${outputHash}.jpg`,
      providerReadableUrl: 'https://cdn.example.test/export.jpg',
      providerReadableUrlExpiresAt: '2099-01-01T00:00:00Z',
    },
  });
}

async function setupDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE SCHEMA private;
    CREATE TABLE auth.users (id UUID PRIMARY KEY);
    CREATE TABLE public.pods (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES auth.users(id),
      accepted_strategy TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE public.subscriptions (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id),
      tier TEXT NOT NULL,
      status TEXT NOT NULL,
      current_period_end TIMESTAMPTZ NOT NULL,
      subscription_started_at TIMESTAMPTZ,
      current_period_start TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.social_posts (
      id UUID PRIMARY KEY,
      pod_id UUID NOT NULL REFERENCES public.pods(id),
      platform TEXT NOT NULL,
      body TEXT NOT NULL,
      media_asset_ids UUID[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      provider_post_id TEXT,
      generation_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.pod_preferences (
      id UUID PRIMARY KEY,
      pod_id UUID NOT NULL REFERENCES public.pods(id),
      preference_type TEXT NOT NULL,
      preference_value JSONB NOT NULL,
      source TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.pod_assets (
      id UUID PRIMARY KEY,
      pod_id UUID NOT NULL REFERENCES public.pods(id),
      storage_path TEXT NOT NULL,
      file_name TEXT,
      media_type TEXT,
      file_size BIGINT,
      asset_role TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.exec(connectionSql);
  await db.exec(publisherSql);
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${ids.user}');
    INSERT INTO public.pods (id, user_id, accepted_strategy, status)
      VALUES ('${ids.pod}', '${ids.user}', 'Approved synthetic pod strategy', 'active');
    INSERT INTO public.subscriptions (user_id, tier, status, current_period_end)
      VALUES ('${ids.user}', 'starter', 'active', '2099-01-01T00:00:00Z');
    INSERT INTO private.meta_organic_connections (
      id, user_id, pod_id, provider, provider_account_id, account_label, status,
      granted_scopes, expires_at
    ) VALUES (
      '${ids.account}', '${ids.user}', '${ids.pod}', 'facebook', '101',
      'Main Page', 'connected', ARRAY['pages_manage_posts','pages_read_engagement'],
      '2099-01-01T00:00:00Z'
    );
    INSERT INTO private.meta_organic_connections (
      id, user_id, pod_id, provider, provider_account_id, account_label, status,
      granted_scopes, expires_at
    ) VALUES (
      '${ids.account2}', '${ids.user}', '${ids.pod}', 'facebook', '201',
      'Second Page', 'connected', ARRAY['pages_manage_posts','pages_read_engagement'],
      '2099-01-01T00:00:00Z'
    );
    INSERT INTO private.meta_organic_credentials (
      connection_id, token_kind, encrypted_access_token, encryption_key_version
    ) VALUES (
      '${ids.account}', 'page', 'syntheticEncryptedAccessTokenValue_000000000000', 'test-v1'
    );
    INSERT INTO private.meta_organic_credentials (
      connection_id, token_kind, encrypted_access_token, encryption_key_version
    ) VALUES (
      '${ids.account2}', 'page', 'syntheticEncryptedAccessTokenValue_000000000001', 'test-v1'
    );
    INSERT INTO public.social_posts (
      id, pod_id, platform, body, status, scheduled_at, generation_date
    ) VALUES (
      '${ids.draft}', '${ids.pod}', 'facebook', 'Approved synthetic caption',
      'scheduled', '2098-10-12T03:00:00Z', '2026-10-12'
    );
    INSERT INTO public.pod_preferences (
      id, pod_id, preference_type, preference_value, source, active, created_at
    ) VALUES (
      '${ids.creativeApproval}', '${ids.pod}', 'creative_review',
      ${literalJson({
        post_id: ids.draft,
        headline: 'Synthetic approved headline',
        call_to_action: 'Learn more',
        content_snapshot: 'Approved synthetic caption',
        status: 'approved',
        approved_at: '2026-10-11T00:00:00Z',
        image: { kind: 'upload', storage_path: `${ids.user}/${ids.pod}/synthetic-source.jpg` },
        artwork_contract_version: 'meta_organic_creative_composition_v2',
        composition: {
          version: 'meta_organic_creative_composition_v2',
          layout: 'meta-organic-portrait-v1',
          font_contract: 'system-ui-safe-v1',
          brand_name: 'Synthetic Pod',
          image_role: 'image',
          typography_only: false,
          headline: 'Synthetic approved headline',
          call_to_action: 'Learn more',
        },
        source_evidence: {
          kind: 'upload',
          storage_path: `${ids.user}/${ids.pod}/synthetic-source.jpg`,
          identity: `${ids.user}/${ids.pod}/synthetic-source.jpg`,
          hash: syntheticSourceHash,
          object_version: 'object-version-synthetic',
          media_type: 'image/jpeg',
          byte_length: syntheticSourceBytes.byteLength,
        },
        final_render_evidence: {
          hash: crypto.createHash('sha256').update('synthetic-jpeg-Approved synthetic caption').digest('hex'),
          mediaType: 'image/jpeg',
          dimensions: { width: 1080, height: 1350 },
          byteLength: Buffer.byteLength('synthetic-jpeg-Approved synthetic caption'),
          rendererVersion: 'sharp_svg_jpeg_2026_10_12_v1',
        },
      })},
      'user_override', true, '2026-10-11T00:00:00Z'
    );
    INSERT INTO public.pod_assets (
      id, pod_id, storage_path, file_name, media_type, file_size, asset_role
    ) VALUES (
      '${uuid(20)}', '${ids.pod}',
      '${ids.user}/${ids.pod}/synthetic-source.jpg',
      'synthetic-source.jpg', 'image/jpeg', ${syntheticSourceBytes.byteLength}, 'campaign_asset'
    );
  `);
  const approvalRow = (await db.query(
    'SELECT id, pod_id, preference_type, preference_value, active, created_at FROM public.pod_preferences WHERE id = $1',
    [ids.creativeApproval],
  )).rows[0];
  const draftRow = (await db.query('SELECT id, platform, body, status FROM public.social_posts WHERE id = $1', [ids.draft])).rows[0];
  const approval = approvalRow.preference_value;
  const normalized = {
    post: {
      id: ids.draft,
      userId: ids.user,
      podId: ids.pod,
      provider: draftRow.platform,
      status: draftRow.status,
      caption: draftRow.body,
      contentVersion: crypto.createHash('md5').update(draftRow.body).digest('hex'),
      contentHash: crypto.createHash('sha256').update(Buffer.from(draftRow.body)).digest('hex'),
    },
    approval: {
      id: approvalRow.id,
      rowCreatedAt: approvalRow.created_at,
      approvedAt: approval.approved_at,
      contentSnapshot: approval.content_snapshot,
      sourceEvidence: normalizeMetaOrganicSourceEvidenceForAttestation(approval.source_evidence),
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
  };
  const attestationPayload = buildMetaOrganicCreativeApprovalAttestationPayload({
    approvalRow,
    approval,
    normalized,
  });
  const attestation = createMetaOrganicCreativeApprovalAttestation({
    approvalRow,
    approval,
    normalized,
    env: process.env,
  });
  await db.query(
    "UPDATE public.pod_preferences SET preference_value = jsonb_set(preference_value, '{server_attestation}', $1::jsonb) WHERE id = $2",
    [JSON.stringify(attestation), ids.creativeApproval],
  );
  await db.query(
    'SELECT public.persist_meta_organic_creative_approval_attestation($1::jsonb)',
    [JSON.stringify({
      approvalId: ids.creativeApproval,
      userId: ids.user,
      podId: ids.pod,
      postId: ids.draft,
      contentHash: normalized.post.contentHash,
      sourceHash: syntheticSourceHash,
      outputHash: approval.final_render_evidence.hash,
      payloadHash: attestation.payloadHash,
      signature: attestation.signature,
      version: attestation.version,
      payload: attestationPayload,
    })],
  );
  return db;
}

async function attestCurrentCreativeApproval(db) {
  const approvalRow = (await db.query(
    'SELECT id, pod_id, preference_type, preference_value, active, created_at FROM public.pod_preferences WHERE id = $1',
    [ids.creativeApproval],
  )).rows[0];
  const draftRow = (await db.query('SELECT id, platform, body, status FROM public.social_posts WHERE id = $1', [ids.draft])).rows[0];
  const approval = approvalRow.preference_value;
  const normalized = {
    post: {
      id: ids.draft,
      userId: ids.user,
      podId: ids.pod,
      provider: draftRow.platform,
      status: draftRow.status,
      caption: draftRow.body,
      contentVersion: crypto.createHash('md5').update(draftRow.body).digest('hex'),
      contentHash: crypto.createHash('sha256').update(Buffer.from(draftRow.body)).digest('hex'),
    },
    approval: {
      id: approvalRow.id,
      rowCreatedAt: approvalRow.created_at,
      approvedAt: approval.approved_at,
      contentSnapshot: approval.content_snapshot,
      sourceEvidence: normalizeMetaOrganicSourceEvidenceForAttestation(approval.source_evidence),
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
  };
  const payload = buildMetaOrganicCreativeApprovalAttestationPayload({ approvalRow, approval, normalized });
  const attestation = createMetaOrganicCreativeApprovalAttestation({ approvalRow, approval, normalized, env: process.env });
  await db.query(
    "UPDATE public.pod_preferences SET preference_value = jsonb_set(preference_value, '{server_attestation}', $1::jsonb) WHERE id = $2",
    [JSON.stringify(attestation), ids.creativeApproval],
  );
  await db.query('DELETE FROM private.meta_organic_creative_approval_attestations WHERE approval_id = $1', [ids.creativeApproval]);
  await db.query(
    'SELECT public.persist_meta_organic_creative_approval_attestation($1::jsonb)',
    [JSON.stringify({
      approvalId: ids.creativeApproval,
      userId: ids.user,
      podId: ids.pod,
      postId: ids.draft,
      contentHash: normalized.post.contentHash,
      sourceHash: normalized.approval.sourceEvidence.hash || null,
      outputHash: approval.final_render_evidence.hash,
      payloadHash: attestation.payloadHash,
      signature: attestation.signature,
      version: attestation.version,
      payload,
    })],
  );
  return { approval, normalized, payload, attestation };
}

async function seedApprovalAndExport(db, p = proposal()) {
  const outputHash = crypto.createHash('sha256').update('rendered-output-v1').digest('hex');
  const manifest = {
    contractVersion: 'meta_organic_artwork_export_v1',
    status: 'exported',
    immutable: true,
    authority: {
      userId: p.userId,
      podId: p.podId,
      postId: p.draftId,
      provider: p.provider,
      accountConnectionId: p.accountConnectionId,
      providerAccountId: p.accountConnectionId === ids.account2 ? '201' : '101',
      creativeApprovalId: ids.creativeApproval,
      approvedAt: '2026-10-11T00:00:00.000Z',
      contentVersion: p.contentVersion,
      contentHash: crypto.createHash('sha256').update('Approved synthetic caption').digest('hex'),
      sourceIdentity: `${p.userId}/${p.podId}/synthetic-source.jpg`,
      sourceHash: syntheticSourceHash,
      sourceKind: 'upload',
      rendererVersion: 'sharp_svg_jpeg_2026_10_12_v1',
    },
    composition: {
      version: 'meta_organic_creative_composition_v2',
      layout: 'meta-organic-portrait-v1',
      fontContract: 'system-ui-safe-v1',
      brandName: 'Synthetic Pod',
      imageRole: 'image',
      typographyOnly: false,
      headline: 'Synthetic approved headline',
      callToAction: 'Learn more',
      captionSnapshot: 'Approved synthetic caption',
    },
    output: {
      hash: outputHash,
      mediaType: 'image/jpeg',
      dimensions: { width: 1080, height: 1350 },
      byteLength: 1000,
      objectPath: `meta-organic-exports/${p.userId}/${p.podId}/${p.draftId}/${ids.creativeApproval}/${p.accountConnectionId}/${outputHash}.jpg`,
      providerReadableUrl: 'https://cdn.example.test/export.jpg',
      providerReadableUrlExpiresAt: '2099-01-01T00:00:00Z',
    },
    source: {
      kind: 'upload',
      identity: `${p.userId}/${p.podId}/synthetic-source.jpg`,
      hash: syntheticSourceHash,
      objectVersion: 'object-version-synthetic',
      mediaType: 'image/jpeg',
      byteLength: syntheticSourceBytes.byteLength,
    },
  };
  manifest.manifestHash = computeMetaOrganicArtworkManifestHash(manifest);
  assert.equal(manifest.manifestHash, p.assetManifestHash);
  await db.exec(`
    INSERT INTO private.meta_organic_publish_approvals (
      id, user_id, pod_id, draft_id, provider, account_connection_id,
      content_version, asset_manifest_hash, campaign_date, status, approved_at, approved_by
    ) VALUES (
      '${p.approvalId}', '${p.userId}', '${p.podId}', '${p.draftId}', '${p.provider}',
      '${p.accountConnectionId}', '${p.contentVersion}', '${p.assetManifestHash}',
      '${p.campaignDate}', 'approved', '2026-10-11T00:00:00Z', '${p.userId}'
    );
    INSERT INTO private.meta_organic_publish_exports (
      manifest_hash, user_id, pod_id, draft_id, account_connection_id,
      media_type, byte_length, output_hash, provider_readable_url,
      provider_readable_url_expires_at, object_version, manifest, immutable,
      status, exported_at
    ) VALUES (
      '${p.assetManifestHash}', '${p.userId}', '${p.podId}', '${p.draftId}',
      '${p.accountConnectionId}', 'image/jpeg', 1000, '${outputHash}',
      'https://cdn.example.test/export.jpg', '2099-01-01T00:00:00Z',
      '${manifest.output.objectPath}', ${literalJson(manifest)}, true, 'exported',
      '2026-10-11T00:00:00Z'
    );
  `);
}

async function enqueue(db, p = proposal()) {
  const result = await db.query(`SELECT public.enqueue_meta_organic_publish_job(${literalJson(p)}) AS job`);
  return result.rows[0].job;
}

async function claim(db, worker = 'worker-a', at = '2098-10-12T03:00:00Z') {
  const result = await db.query(`SELECT public.claim_meta_organic_publish_job('${worker}', '${at}'::timestamptz, 300000) AS job`);
  return result.rows[0].job;
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return literalJson(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rpcFor(db) {
  return async (name, params) => {
    const argsByName = {
      enqueue_meta_organic_publish_job: [params.p_proposal],
      claim_meta_organic_publish_job: [params.p_worker_id, params.p_now, params.p_lease_ms],
      get_meta_organic_publish_context: [params.p_job_id, params.p_worker_id, params.p_operation_token],
      mark_meta_organic_publish_blocked: [params.p_job_id, params.p_worker_id, params.p_operation_token, params.p_reason, params.p_details],
      mark_meta_organic_publish_retry: [params.p_job_id, params.p_worker_id, params.p_operation_token, params.p_reason, params.p_details, params.p_retry_at],
      mark_meta_organic_publish_failed: [params.p_job_id, params.p_worker_id, params.p_operation_token, params.p_reason, params.p_details],
      mark_meta_organic_publish_unknown: [params.p_job_id, params.p_worker_id, params.p_operation_token, params.p_reason, params.p_receipt],
      mark_meta_organic_publish_published: [params.p_job_id, params.p_worker_id, params.p_operation_token, params.p_receipt],
      claim_meta_organic_reconciliation_job: [params.p_worker_id, params.p_now, params.p_lease_ms],
      mark_meta_organic_publish_reconciled: [params.p_job_id, params.p_worker_id, params.p_operation_token, params.p_receipt],
      mark_meta_organic_reconciliation_inconclusive: [params.p_job_id, params.p_worker_id, params.p_operation_token, params.p_reason, params.p_receipt],
      get_meta_organic_artwork_export_context: [params.p_request],
      persist_meta_organic_artwork_export_manifest: [params.p_manifest],
      persist_meta_organic_creative_approval_attestation: [params.p_attestation],
    };
    if (!argsByName[name]) throw new Error(`Unhandled RPC ${name}`);
    try {
      const result = await db.query(`SELECT public.${name}(${argsByName[name].map(sqlValue).join(', ')}) AS result`);
      return result.rows[0].result;
    } catch (error) {
      const message = error?.message || String(error);
      const known = message.match(/(?:PUBLISH|EXPORT)_[A-Z_]+/)?.[0];
      if (known) error.code = known;
      throw error;
    }
  };
}

async function checkExecutableQueueAndContext() {
  const db = await setupDb();
  const p = proposal();
  const queued = await enqueue(db, p);
  assert.equal(queued.duplicate, false);
  const claimed = await claim(db);
  assert.equal(claimed.id, queued.id);
  assert.equal(claimed.state, 'leased');
  assert.match(claimed.operationToken, /^[a-f0-9]{48,128}$/);
  await assert.rejects(() => db.query(`SELECT public.get_meta_organic_publish_context('${claimed.id}', '${claimed.leasedBy}', '${claimed.operationToken}')`), /PUBLISH_APPROVAL_CONTEXT_REQUIRED/);
  await seedApprovalAndExport(db, p);
  const context = await db.query(`SELECT public.get_meta_organic_publish_context('${claimed.id}', '${claimed.leasedBy}', '${claimed.operationToken}') AS context`);
  assert.equal(context.rows[0].context.proposal.id, claimed.id);
  assert.equal(context.rows[0].context.draft.caption, 'Approved synthetic caption');
  assert.equal(context.rows[0].context.account.encryptedAccessToken, undefined);
  assert.equal(context.rows[0].context.account.providerAccountId, '101');
}

async function checkDurableArtworkExportStoreContract() {
  const db = await setupDb();
  const rpc = rpcFor(db);
  const store = createRpcMetaOrganicArtworkExportStore({ rpc });
  const uploaded = new Map();
  const storage = {
    async readPodAsset({ storagePath }) {
      assert.equal(storagePath, `${ids.user}/${ids.pod}/synthetic-source.jpg`);
      return { bytes: syntheticSourceBytes, contentType: 'image/jpeg', objectVersion: 'object-version-synthetic' };
    },
    async putImmutableObject(path, bytes) {
      if (uploaded.has(path)) throw new Error('immutable overwrite');
      uploaded.set(path, Buffer.from(bytes));
    },
    async createReadOnlySignedUrl(path, ttlSeconds) {
      assert.ok(ttlSeconds >= 14_400);
      return { url: `https://cdn.example.test/${encodeURIComponent(path)}`, expiresAt: '2099-01-01T00:00:00Z' };
    },
  };
  const renderer = async (composition) => Buffer.from(`synthetic-jpeg-${composition.caption}`);
  const debugAtt = await db.query(`
    SELECT
      att.approved_payload->'sourceEvidence' AS att_source,
      CASE coalesce(approval.preference_value->'source_evidence', approval.preference_value->'sourceEvidence')->>'kind'
        WHEN 'upload' THEN jsonb_build_object(
          'kind', 'upload',
          'identity', coalesce(approval.preference_value->'source_evidence'->'storage_path', approval.preference_value->'source_evidence'->'storagePath', approval.preference_value->'source_evidence'->'identity'),
          'hash', coalesce(approval.preference_value->'source_evidence'->'hash', approval.preference_value->'source_evidence'->'sha256', 'null'::jsonb),
          'mediaType', coalesce(approval.preference_value->'source_evidence'->'media_type', approval.preference_value->'source_evidence'->'mediaType', approval.preference_value->'source_evidence'->'content_type', approval.preference_value->'source_evidence'->'contentType', 'null'::jsonb),
          'byteLength', coalesce(approval.preference_value->'source_evidence'->'byte_length', approval.preference_value->'source_evidence'->'byteLength', '0'::jsonb),
          'objectVersion', coalesce(approval.preference_value->'source_evidence'->'object_version', approval.preference_value->'source_evidence'->'objectVersion', approval.preference_value->'source_evidence'->'revision', 'null'::jsonb))
        ELSE '{}'::jsonb
      END AS expected_source
    FROM private.meta_organic_creative_approval_attestations att
    JOIN public.pod_preferences approval ON approval.id = att.approval_id
    WHERE approval.id = '${ids.creativeApproval}'
  `);
  assert.deepEqual(debugAtt.rows[0].att_source, debugAtt.rows[0].expected_source);
  const debugAttChecks = await db.query(`
    SELECT
      att.user_id = pod.user_id AS user_ok,
      att.pod_id = pod.id AS pod_ok,
      att.draft_id = draft.id AS draft_ok,
      att.version = 'meta_organic_creative_approval_attestation_v1' AS version_ok,
      att.content_hash = encode(sha256(convert_to(draft.body, 'UTF8')), 'hex') AS content_ok,
      att.output_hash = approval.preference_value->'final_render_evidence'->>'hash' AS output_ok,
      att.payload_hash = approval.preference_value->'server_attestation'->>'payloadHash' AS payload_hash_ok,
      att.signature = approval.preference_value->'server_attestation'->>'signature' AS signature_ok,
      encode(sha256(convert_to(private.meta_organic_canonical_json(att.approved_payload), 'UTF8')), 'hex') = att.payload_hash AS sql_hash_ok,
      att.approved_payload->'authority'->>'contentHash' = encode(sha256(convert_to(draft.body, 'UTF8')), 'hex') AS authority_hash_ok,
      att.approved_payload->'authority'->>'contentVersion' = md5(draft.body) AS authority_version_ok,
      (att.approved_payload->'authority'->>'approvedAt')::timestamptz = (approval.preference_value->>'approved_at')::timestamptz AS approved_at_ok,
      att.approved_payload->'image' IS NOT DISTINCT FROM coalesce(approval.preference_value->'image', 'null'::jsonb) AS image_ok,
      att.approved_payload->'finalRenderEvidence' IS NOT DISTINCT FROM approval.preference_value->'final_render_evidence' AS render_ok,
      att.approved_payload->'composition' IS NOT DISTINCT FROM jsonb_build_object(
        'version', approval.preference_value->'composition'->'version',
        'layout', approval.preference_value->'composition'->'layout',
        'fontContract', approval.preference_value->'composition'->'font_contract',
        'brandName', approval.preference_value->'composition'->'brand_name',
        'imageRole', approval.preference_value->'composition'->'image_role',
        'typographyOnly', approval.preference_value->'composition'->'typography_only',
        'headline', approval.preference_value->'composition'->'headline',
        'callToAction', approval.preference_value->'composition'->'call_to_action') AS composition_ok
    FROM private.meta_organic_creative_approval_attestations att
    JOIN public.pod_preferences approval ON approval.id = att.approval_id
    JOIN public.social_posts draft ON draft.id = att.draft_id
    JOIN public.pods pod ON pod.id = att.pod_id
    WHERE approval.id = '${ids.creativeApproval}'
  `);
  assert.deepEqual(Object.values(debugAttChecks.rows[0]).filter((value) => value !== true), []);
  const first = await exportApprovedMetaOrganicArtwork({
    request: buildMetaOrganicArtworkExportRequest({
      userId: ids.user,
      podId: ids.pod,
      postId: ids.draft,
      provider: 'facebook',
      accountConnectionId: ids.account,
      providerAccountId: '101',
      creativeApprovalId: ids.creativeApproval,
    }),
    store,
    storage,
    renderer,
    now: new Date('2026-10-12T00:00:00Z'),
  });
  const second = await exportApprovedMetaOrganicArtwork({
    request: buildMetaOrganicArtworkExportRequest({
      userId: ids.user,
      podId: ids.pod,
      postId: ids.draft,
      provider: 'facebook',
      accountConnectionId: ids.account2,
      providerAccountId: '201',
      creativeApprovalId: ids.creativeApproval,
    }),
    store,
    storage: { ...storage, putImmutableObject: async () => undefined },
    renderer,
    now: new Date('2026-10-12T00:00:00Z'),
  });

  assert.equal(first.status, 'exported', first.reason);
  assert.equal(second.status, 'exported', second.reason);
  assert.equal(first.manifest.authority.creativeApprovalId, ids.creativeApproval);
  assert.equal(first.manifest.authority.approvalId, undefined);
  assert.notEqual(first.manifest.manifestHash, second.manifest.manifestHash);

  const exportRows = await db.query(`SELECT manifest_hash, account_connection_id, manifest FROM private.meta_organic_publish_exports ORDER BY account_connection_id`);
  assert.equal(exportRows.rows.length, 2);
  assert.equal(exportRows.rows[0].manifest.authority.creativeApprovalId, ids.creativeApproval);
  assert.equal(exportRows.rows[0].manifest.authority.approvalId, undefined);
  const approvals = await db.query(`SELECT count(*)::int AS count FROM private.meta_organic_publish_approvals`);
  assert.equal(approvals.rows[0].count, 0);

  // Bypass the JS adapter: these assertions exercise the durable RPC itself.
  const persistDirect = (manifest) => db.query(
    'SELECT public.persist_meta_organic_artwork_export_manifest($1::jsonb)', [JSON.stringify(manifest)]);
  for (const mutate of [
    (m) => { m.output.providerReadableUrl = 'https://different.example.test/art.jpg'; },
    (m) => { m.output.providerReadableUrlExpiresAt = '2099-02-01T00:00:00Z'; },
    (m) => { m.composition.headline = 'Changed without new approval'; },
  ]) {
    const changed = structuredClone(first.manifest);
    mutate(changed);
    await assert.rejects(() => persistDirect(changed), /EXPORT_MANIFEST_HASH_MISMATCH/);
  }
  for (const mutate of [
    (m) => { m.output.hash = 'f'.repeat(64); m.output.objectPath = m.output.objectPath.replace(first.manifest.output.hash, m.output.hash); },
    (m) => { m.source.hash = 'f'.repeat(64); m.authority.sourceHash = m.source.hash; },
    (m) => { m.authority.contentHash = 'f'.repeat(64); },
  ]) {
    const changed = structuredClone(first.manifest);
    mutate(changed);
    changed.manifestHash = computeMetaOrganicArtworkManifestHash(changed);
    await assert.rejects(() => persistDirect(changed), /EXPORT_APPROVAL_ATTESTATION_REQUIRED/);
  }
  for (const mutate of [
    (m) => { m.composition.headline = 'Changed without new approval'; },
    (m) => { m.output.byteLength += 1; },
    (m) => { m.output.dimensions.width = 900; },
  ]) {
    const changed = structuredClone(first.manifest);
    mutate(changed);
    changed.manifestHash = computeMetaOrganicArtworkManifestHash(changed);
    await assert.rejects(() => persistDirect(changed), /EXPORT_REVIEWED_ARTWORK_CHANGED/);
  }
  const otherOwner = structuredClone(first.manifest);
  otherOwner.authority.userId = uuid(999);
  otherOwner.output.objectPath = otherOwner.output.objectPath.replace(ids.user, uuid(999));
  otherOwner.manifestHash = computeMetaOrganicArtworkManifestHash(otherOwner);
  await assert.rejects(() => persistDirect(otherOwner), /EXPORT_ACCOUNT_CONTEXT_REQUIRED/);

  const originalReview = (await db.query('SELECT preference_value FROM public.pod_preferences WHERE id = $1', [ids.creativeApproval])).rows[0].preference_value;
  for (const mutate of [
    (r) => { r.final_render_evidence.hash = 'f'.repeat(64); },
    (r) => { r.source_evidence.hash = 'f'.repeat(64); },
    (r) => { r.composition.headline = 'Same row changed'; },
  ]) {
    const changed = structuredClone(originalReview);
    mutate(changed);
    await db.query('UPDATE public.pod_preferences SET preference_value = $1::jsonb WHERE id = $2', [JSON.stringify(changed), ids.creativeApproval]);
    await assert.rejects(() => persistDirect(first.manifest), /EXPORT_APPROVAL_ATTESTATION_REQUIRED/);
    await db.query('UPDATE public.pod_preferences SET preference_value = $1::jsonb WHERE id = $2', [JSON.stringify(originalReview), ids.creativeApproval]);
  }
  const helperAcl = await db.query("SELECT has_function_privilege('authenticated', 'private.meta_organic_canonical_json(jsonb)', 'EXECUTE') AS browser, has_function_privilege('service_role', 'private.meta_organic_canonical_json(jsonb)', 'EXECUTE') AS service");
  assert.equal(helperAcl.rows[0].browser, false);
  assert.equal(helperAcl.rows[0].service, false);

  await assert.rejects(() => store.persistExportManifest(first.manifest), /EXPORT_MANIFEST_IMMUTABLE/);
}

async function checkCreativeApprovalSourceKindSqlSuccess() {
  for (const variant of ['source', 'typography_only']) {
    const db = await setupDb();
    const originalReview = (await db.query('SELECT preference_value FROM public.pod_preferences WHERE id = $1', [ids.creativeApproval])).rows[0].preference_value;
    const changed = structuredClone(originalReview);
    if (variant === 'source') {
      changed.image = { kind: 'source', url: 'https://example.com/source.jpg', source_url: 'https://example.com/' };
      changed.source_evidence = {
        kind: 'source',
        url: 'https://example.com/source.jpg',
        source_url: 'https://example.com/',
        identity: 'https://example.com/source.jpg',
        hash: syntheticSourceHash,
        revision: syntheticSourceHash,
        media_type: 'image/jpeg',
        byte_length: syntheticSourceBytes.byteLength,
      };
      changed.composition.image_role = 'image';
      changed.composition.typography_only = false;
    } else {
      changed.image = null;
      changed.source_evidence = {
        kind: 'typography_only',
        identity: 'typography-only',
        hash: null,
        mediaType: null,
        byteLength: 0,
      };
      changed.composition.image_role = 'typography';
      changed.composition.typography_only = true;
    }
    await db.query('UPDATE public.pod_preferences SET preference_value = $1::jsonb WHERE id = $2', [JSON.stringify(changed), ids.creativeApproval]);
    const attested = await attestCurrentCreativeApproval(db);
    assert.equal(attested.normalized.approval.sourceEvidence.kind, variant);
    const context = await db.query(
      'SELECT public.get_meta_organic_artwork_export_context($1::jsonb) AS context',
      [JSON.stringify(buildMetaOrganicArtworkExportRequest({
        userId: ids.user,
        podId: ids.pod,
        postId: ids.draft,
        provider: 'facebook',
        accountConnectionId: ids.account,
        providerAccountId: '101',
        creativeApprovalId: ids.creativeApproval,
      }))],
    );
    assert.equal(context.rows[0].context.approvalRow.preference_value.source_evidence.kind, variant);
  }
}

async function checkLeaseAndPrivilegeFences() {
  const db = await setupDb();
  await enqueue(db, proposal());
  const claimed = await claim(db, 'worker-a');
  assert.equal(await claim(db, 'worker-b'), null);
  await db.exec(`UPDATE private.meta_organic_publish_jobs SET lease_expires_at = '2026-10-12T02:00:00Z' WHERE id = '${claimed.id}'`);
  await assert.rejects(
    () => db.query(`SELECT public.mark_meta_organic_publish_published('${claimed.id}', 'worker-a', '${claimed.operationToken}', ${literalJson({ providerAccountId: '101', providerPostId: 'post-1' })})`),
    /PUBLISH_LEASE_REQUIRED/,
  );
  const unknown = await db.query(`SELECT public.mark_meta_organic_publish_unknown('${claimed.id}', 'worker-a', '${claimed.operationToken}', 'OUTCOME_UNKNOWN', ${literalJson({ providerAccountId: '101' })}) AS job`);
  assert.equal(unknown.rows[0].job.state, 'unknown');
  await db.exec(`UPDATE private.meta_organic_publish_jobs SET state = 'retry', retry_at = '2098-10-13T00:00:00Z', leased_by = NULL, lease_expires_at = NULL WHERE id = '${claimed.id}'`);
  assert.equal(await claim(db, 'worker-c', '2098-10-12T04:00:00Z'), null);
  await db.exec('GRANT USAGE ON SCHEMA private TO authenticated');
  const privileges = await db.query(`
    SELECT
      has_function_privilege('authenticated', 'public.claim_meta_organic_publish_job(text,timestamp with time zone,integer)', 'EXECUTE') AS can_claim,
      has_function_privilege('authenticated', 'public.get_meta_organic_artwork_export_context(jsonb)', 'EXECUTE') AS can_export_context,
      has_function_privilege('authenticated', 'public.persist_meta_organic_artwork_export_manifest(jsonb)', 'EXECUTE') AS can_export_manifest,
      has_function_privilege('authenticated', 'private.meta_organic_require_lease(uuid,text,text,boolean)', 'EXECUTE') AS can_require_lease,
      has_schema_privilege('authenticated', 'private', 'USAGE') AS can_use_private_schema,
      has_table_privilege('authenticated', 'private.meta_organic_publish_jobs', 'SELECT') AS can_read_jobs
  `);
  assert.equal(privileges.rows[0].can_claim, false);
  assert.equal(privileges.rows[0].can_export_context, false);
  assert.equal(privileges.rows[0].can_export_manifest, false);
  assert.equal(privileges.rows[0].can_require_lease, false);
  assert.equal(privileges.rows[0].can_use_private_schema, true);
  assert.equal(privileges.rows[0].can_read_jobs, false);
}

async function checkUnknownTransition() {
  const db = await setupDb();
  await enqueue(db, proposal());
  const claimed = await claim(db, 'worker-unknown');
  const marked = await db.query(`SELECT public.mark_meta_organic_publish_unknown(
    '${claimed.id}',
    'worker-unknown',
    '${claimed.operationToken}',
    'OUTCOME_UNKNOWN',
    ${literalJson({ providerAccountId: '101', operation: 'page_photo_publish' })}
  ) AS job`);
  assert.equal(marked.rows[0].job.state, 'unknown');
  assert.equal(await claim(db, 'worker-again', '2098-10-12T04:00:00Z'), null);
  const receipts = await db.query(`SELECT status, provider_account_id, raw_receipt FROM private.meta_organic_publish_receipts WHERE job_id = '${claimed.id}'`);
  assert.equal(receipts.rows.length, 1);
  assert.equal(receipts.rows[0].status, 'unknown');
}

async function checkRpcWorkerSuccessAndChangedDraftBlock() {
  const db = await setupDb();
  const p = proposal();
  await enqueue(db, p);
  await seedApprovalAndExport(db, p);
  const calls = [];
  const store = createRpcMetaOrganicPublishStore({ rpc: rpcFor(db) });
  const result = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300000 },
    store,
    provider: {
      async publishFacebookPagePhoto(payload) {
        calls.push(payload);
        return { provider: 'facebook', providerAccountId: '101', providerPostId: 'post-101' };
      },
    },
    workerId: 'rpc-worker',
    now: new Date('2098-10-12T03:00:00Z'),
  });
  assert.equal(result.status, 'published');
  assert.equal(calls.length, 1);

  const changedDb = await setupDb();
  const changedProposal = proposal();
  await enqueue(changedDb, changedProposal);
  await seedApprovalAndExport(changedDb, changedProposal);
  await changedDb.exec(`UPDATE public.social_posts SET body = 'Changed caption after approval', updated_at = '2098-10-12T03:01:00Z' WHERE id = '${ids.draft}'`);
  const changedCalls = [];
  const changedResult = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300000 },
    store: createRpcMetaOrganicPublishStore({ rpc: rpcFor(changedDb) }),
    provider: {
      async publishFacebookPagePhoto(payload) {
        changedCalls.push(payload);
        return { provider: 'facebook', providerAccountId: '101', providerPostId: 'post-should-not-happen' };
      },
    },
    workerId: 'rpc-worker',
    now: new Date('2098-10-12T03:00:00Z'),
  });
  assert.equal(changedResult.status, 'blocked');
  assert.equal(changedResult.reason, 'PUBLISH_CONTENT_CHANGED');
  assert.equal(changedCalls.length, 0);
}

async function checkRpcReconciliationSuccess() {
  const db = await setupDb();
  const p = proposal();
  await enqueue(db, p);
  await seedApprovalAndExport(db, p);
  const store = createRpcMetaOrganicPublishStore({ rpc: rpcFor(db) });
  const publishCalls = [];
  const unknown = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300000 },
    store,
    provider: {
      async publishFacebookPagePhoto() {
        publishCalls.push('publish');
        const error = new Error('timeout after write');
        error.code = 'REQUEST_TIMEOUT';
        throw error;
      },
    },
    workerId: 'rpc-worker',
    now: new Date('2098-10-12T03:00:00Z'),
  });
  assert.equal(unknown.status, 'unknown');

  const reconciled = await reconcileNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300000 },
    store,
    provider: {
      async lookupPublishedMetaOrganicReceipt() {
        return {
          provider: 'facebook',
          providerAccountId: '101',
          providerPostId: 'post-reconciled-101',
          dedupeKey: p.dedupeKey,
        };
      },
    },
    workerId: 'rpc-reconciler',
    now: new Date('2098-10-12T03:02:00Z'),
  });
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(publishCalls.length, 1);
  const rows = await db.query(`SELECT status, provider_account_id, provider_post_id FROM private.meta_organic_publish_receipts WHERE job_id = '${unknown.jobId}' ORDER BY created_at DESC`);
  assert.equal(rows.rows[0].status, 'reconciled');
  assert.equal(rows.rows[0].provider_account_id, '101');
}

async function checkReapprovalDedupe() {
  const db = await setupDb();
  const first = await enqueue(db, proposal());
  const second = await enqueue(db, proposal({ approvalId: ids.approval2 }));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  const count = await db.query('SELECT count(*)::int AS total FROM private.meta_organic_publish_jobs');
  assert.equal(count.rows[0].total, 1);
}

async function checkAllowanceWindowRolloverAndReservations() {
  const db = await setupDb();
  await db.exec(`
    UPDATE public.subscriptions
    SET tier = 'scale', subscription_started_at = '2098-09-15T00:00:00Z', current_period_start = '2098-09-15T00:00:00Z'
    WHERE user_id = '${ids.user}'
  `);
  for (let day = 15; day <= 30; day += 1) {
    await enqueue(db, proposal({ draftId: uuid(1000 + day), contentVersion: `old-sep-${day}`, campaignDate: `2098-09-${String(day).padStart(2, '0')}` }));
  }
  for (let day = 1; day <= 14; day += 1) {
    await enqueue(db, proposal({ draftId: uuid(2000 + day), contentVersion: `old-oct-${day}`, campaignDate: `2098-10-${String(day).padStart(2, '0')}` }));
  }
  const rollover = await enqueue(db, proposal({ draftId: uuid(3015), contentVersion: 'new-window-first-day', campaignDate: '2098-10-15' }));
  assert.equal(rollover.duplicate, false);

  const sameDateSecondAccount = await enqueue(db, proposal({
    draftId: uuid(3016),
    accountConnectionId: uuid(4016),
    contentVersion: 'new-window-first-day-second-account',
    campaignDate: '2098-10-15',
  }));
  assert.equal(sameDateSecondAccount.duplicate, false);

  const limitedDb = await setupDb();
  await limitedDb.exec(`
    UPDATE public.subscriptions
    SET tier = 'starter', subscription_started_at = '2098-10-01T00:00:00Z', current_period_start = '2098-10-01T00:00:00Z'
    WHERE user_id = '${ids.user}'
  `);
  await enqueue(limitedDb, proposal({ draftId: uuid(5001), contentVersion: 'week-one-a', campaignDate: '2098-10-06' }));
  await enqueue(limitedDb, proposal({ draftId: uuid(5002), contentVersion: 'week-one-b', campaignDate: '2098-10-07' }));
  await assert.rejects(
    () => enqueue(limitedDb, proposal({ draftId: uuid(5003), contentVersion: 'week-one-c', campaignDate: '2098-10-08' })),
    /PUBLISH_WEEKLY_DISTINCT_DAY_LIMIT/,
  );

  const monthlyDb = await setupDb();
  await monthlyDb.exec(`
    UPDATE public.subscriptions
    SET tier = 'starter', subscription_started_at = '2098-10-01T00:00:00Z', current_period_start = '2098-10-01T00:00:00Z'
    WHERE user_id = '${ids.user}'
  `);
  const dates = ['2098-10-01','2098-10-02','2098-10-08','2098-10-09','2098-10-15','2098-10-16','2098-10-22','2098-10-23','2098-10-29','2098-10-30'];
  for (let index = 0; index < dates.length; index += 1) {
    await enqueue(monthlyDb, proposal({ draftId: uuid(6000 + index), contentVersion: `month-${index}`, campaignDate: dates[index] }));
  }
  await assert.rejects(
    () => enqueue(monthlyDb, proposal({ draftId: uuid(7001), contentVersion: 'last-free-day-loser', campaignDate: '2098-10-31' })),
    /PUBLISH_DISTINCT_DAY_LIMIT/,
  );
}

await checkExecutableQueueAndContext();
await checkDurableArtworkExportStoreContract();
await checkCreativeApprovalSourceKindSqlSuccess();
await checkLeaseAndPrivilegeFences();
await checkUnknownTransition();
await checkReapprovalDedupe();
await checkAllowanceWindowRolloverAndReservations();
await checkRpcWorkerSuccessAndChangedDraftBlock();
await checkRpcReconciliationSuccess();
console.log('meta organic publisher proposed SQL PGlite checks passed');
