import crypto from 'node:crypto';
import { loadOwnedPod, rpcWithServiceRole, supabaseAuthedGet, supabaseAuthedPatch, supabaseAuthedPost, verifySupabaseUser } from './supabaseAuth.js';
import {
  exportApprovedMetaOrganicArtwork,
  prepareMetaOrganicArtworkReviewEvidence,
  createRpcMetaOrganicArtworkExportStore,
  buildMetaOrganicCreativeApprovalAttestationPayload,
  createMetaOrganicCreativeApprovalAttestation,
  normalizeMetaOrganicSourceEvidenceForAttestation,
  META_ORGANIC_ARTWORK_RENDERER_VERSION,
  META_ORGANIC_CREATIVE_COMPOSITION_VERSION,
  META_ORGANIC_CREATIVE_FONT_CONTRACT,
  META_ORGANIC_CREATIVE_LAYOUT,
} from './metaOrganicArtworkExport.js';
import { createReviewedSourceFetcher, createSupabasePodAssetStorage } from './metaOrganicArtworkStorage.js';
import { listMetaConnections, normalizeConnection, META_PROVIDER_KEYS } from './metaOrganic.js';

const PREPARATION_TOKEN_VERSION = 'meta_organic_render_review_token_v1';
const PREPARATION_TTL_MS = 20 * 60 * 1000;

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function md5Hex(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function hmac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function tokenSecret(env = process.env) {
  const secret = env.META_ARTWORK_REVIEW_TOKEN_SECRET || env.META_OAUTH_COOKIE_SECRET || env.META_TOKEN_ENCRYPTION_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw Object.assign(new Error('Rendered artwork review is not configured.'), { code: 'ARTWORK_REVIEW_UNAVAILABLE', status: 503 });
  return secret;
}

function signPreparation(payload, env = process.env) {
  const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
  return `${encoded}.${hmac(encoded, tokenSecret(env))}`;
}

export function verifyPreparationToken(token, env = process.env, now = Date.now()) {
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra) throw Object.assign(new Error('Rendered artwork review has expired. Prepare it again.'), { code: 'ARTWORK_PREPARATION_INVALID', status: 409 });
  const expected = hmac(encoded, tokenSecret(env));
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw Object.assign(new Error('Rendered artwork review was altered. Prepare it again.'), { code: 'ARTWORK_PREPARATION_INVALID', status: 409 });
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (payload.version !== PREPARATION_TOKEN_VERSION || !payload.expiresAt || Date.parse(payload.expiresAt) <= now) {
    throw Object.assign(new Error('Rendered artwork review has expired. Prepare it again.'), { code: 'ARTWORK_PREPARATION_EXPIRED', status: 409 });
  }
  return payload;
}

function normalizeImageReference(image) {
  if (!image) return null;
  if (image.kind === 'upload') {
    const storagePath = cleanString(image.storage_path || image.storagePath, 700);
    if (!storagePath) throw Object.assign(new Error('Choose an uploaded image again.'), { code: 'ARTWORK_SOURCE_REQUIRED', status: 422 });
    return { kind: 'upload', storage_path: storagePath };
  }
  if (image.kind === 'source') {
    const url = cleanString(image.url, 1000);
    const sourceUrl = cleanString(image.source_url || image.sourceUrl, 1000);
    if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error('Choose a reviewed source image again.'), { code: 'ARTWORK_SOURCE_REQUIRED', status: 422 });
    return { kind: 'source', url, source_url: sourceUrl || null };
  }
  throw Object.assign(new Error('Choose a usable creative image.'), { code: 'ARTWORK_SOURCE_REQUIRED', status: 422 });
}

function buildReviewPayload({ post, pod, input, approved = false, approvedAt = null, prepared }) {
  const headline = cleanString(input.headline, 350);
  if (!headline) throw Object.assign(new Error('Add a headline before preparing this creative.'), { code: 'ARTWORK_HEADLINE_REQUIRED', status: 422 });
  const cta = cleanString(input.callToAction ?? input.call_to_action, 80);
  const image = normalizeImageReference(input.image || null);
  const imageRole = image ? (input.imageRole === 'logo' ? 'logo' : 'image') : 'typography';
  const payload = {
    post_id: post.id,
    headline,
    call_to_action: cta,
    image,
    artwork_contract_version: META_ORGANIC_CREATIVE_COMPOSITION_VERSION,
    composition: {
      version: META_ORGANIC_CREATIVE_COMPOSITION_VERSION,
      layout: META_ORGANIC_CREATIVE_LAYOUT,
      font_contract: META_ORGANIC_CREATIVE_FONT_CONTRACT,
      brand_name: cleanString(input.brandName || pod.brand_name || pod.pod_name, 120),
      image_role: imageRole,
      typography_only: !image,
      headline,
      call_to_action: cta,
    },
    content_snapshot: post.body,
    status: approved ? 'approved' : 'rendered_review',
    approved_at: approved ? (approvedAt || new Date().toISOString()) : null,
  };
  if (prepared?.sourceEvidence) payload.source_evidence = prepared.sourceEvidence;
  if (prepared?.finalRenderEvidence) payload.final_render_evidence = prepared.finalRenderEvidence;
  return payload;
}

function normalizePost(row, ownerUserId) {
  return row ? {
    id: row.id,
    userId: ownerUserId,
    podId: row.pod_id,
    platform: row.platform,
    status: row.status,
    body: row.body,
    updated_at: row.updated_at,
  } : null;
}

async function readRows(response, unavailableMessage) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.message || unavailableMessage);
    error.status = response.status;
    throw error;
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

export async function loadArtworkReviewContext({ accessToken, userId, podId, postId }) {
  const pod = await loadOwnedPod(accessToken, podId);
  if (!pod) throw Object.assign(new Error('Pod not found.'), { status: 404, code: 'ARTWORK_POD_NOT_FOUND' });
  const encodedPod = encodeURIComponent(podId);
  const encodedPost = encodeURIComponent(postId);
  const posts = await readRows(await supabaseAuthedGet(`/rest/v1/social_posts?id=eq.${encodedPost}&pod_id=eq.${encodedPod}&select=*`, accessToken), 'Post could not be loaded.');
  const post = normalizePost(posts[0], userId);
  if (!post || post.podId !== podId) throw Object.assign(new Error('Post not found.'), { status: 404, code: 'ARTWORK_POST_NOT_FOUND' });
  const encodedPlatform = encodeURIComponent(post.platform);
  const [assets, websitePreferences, creativeReviews, postTargetSnapshots] = await Promise.all([
    readRows(await supabaseAuthedGet(`/rest/v1/pod_assets?pod_id=eq.${encodedPod}&select=*&order=created_at.desc`, accessToken), 'Pod assets could not be loaded.'),
    readRows(await supabaseAuthedGet(`/rest/v1/pod_preferences?pod_id=eq.${encodedPod}&active=eq.true&preference_type=eq.website_intelligence&select=*&order=created_at.desc,id.desc&limit=1`, accessToken), 'Website source media could not be loaded.'),
    readRows(await supabaseAuthedGet(`/rest/v1/pod_preferences?pod_id=eq.${encodedPod}&active=eq.true&preference_type=eq.creative_review&preference_value->>post_id=eq.${encodedPost}&select=*&order=created_at.desc,id.desc&limit=1`, accessToken), 'Creative review context could not be loaded.'),
    readRows(await supabaseAuthedGet(`/rest/v1/pod_preferences?pod_id=eq.${encodedPod}&active=eq.true&preference_type=eq.social_post_target_snapshot&preference_value->>postId=eq.${encodedPost}&preference_value->>platform=eq.${encodedPlatform}&select=*&order=created_at.asc,id.asc&limit=1`, accessToken), 'Account target snapshot could not be loaded.'),
  ]);
  const websitePreference = websitePreferences.find((row) => Array.isArray(row.preference_value?.source_media));
  const sourceMedia = websitePreference?.preference_value?.source_media || [];
  const metaConnections = META_PROVIDER_KEYS.includes(post.platform)
    ? await listMetaConnections(userId, podId).then((rows) => (Array.isArray(rows) ? rows : []).map((row) => normalizeConnection(row)).filter((row) => row.status === 'connected')).catch(() => [])
    : [];
  const matchingCreativeReviews = creativeReviews
    .filter((row) => row.preference_value?.post_id === postId)
    .sort((a, b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0) || String(b.id || '').localeCompare(String(a.id || '')));
  const matchingTargetSnapshots = postTargetSnapshots
    .filter((row) => row.preference_value?.postId === postId && row.preference_value?.platform === post.platform)
    .sort((a, b) => (Date.parse(a.created_at || '') || 0) - (Date.parse(b.created_at || '') || 0) || String(a.id || '').localeCompare(String(b.id || '')));
  return {
    pod,
    post,
    assets: assets.map((asset) => ({
      id: asset.id,
      pod_id: asset.pod_id,
      storagePath: asset.storage_path,
      name: asset.file_name,
      type: asset.media_type,
      media_type: asset.media_type,
      file_size: asset.file_size,
      assetRole: asset.asset_role,
    })),
    sourceMedia,
    metaConnections,
    latestCreativeReview: matchingCreativeReviews[0] || null,
    accountSnapshot: matchingTargetSnapshots[0] || null,
  };
}

function dataUrl(bytes) {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}

function preparationFingerprint(payload) {
  return sha256Hex(Buffer.from(canonicalJson({
    postId: payload.postId,
    contentHash: payload.contentHash,
    reviewPayload: payload.reviewPayload,
    sourceEvidence: payload.sourceEvidence,
    finalRenderEvidence: payload.finalRenderEvidence,
    rendererVersion: META_ORGANIC_ARTWORK_RENDERER_VERSION,
  })));
}

function latestReviewRevision(row) {
  return row ? {
    id: cleanString(row.id, 120),
    createdAt: cleanString(row.created_at, 80),
    status: cleanString(row.preference_value?.status, 40),
    payloadHash: sha256Hex(Buffer.from(canonicalJson(row.preference_value || null))),
  } : null;
}

function normalizeSnapshotTargets(row, provider, connections = []) {
  const targets = Array.isArray(row?.preference_value?.targets) ? row.preference_value.targets : [];
  return targets.map((target) => ({
    provider: cleanString(target.provider || target.platform, 40).toLowerCase(),
    providerAccountId: cleanString(target.providerAccountId || target.provider_account_id || target.accountId, 80),
    accountConnectionId: cleanString(target.accountConnectionId || target.account_connection_id || target.connectionId, 120),
    accountLabel: cleanString(target.accountLabel || target.account_label || target.label, 200),
  })).map((target) => {
    if (target.provider !== provider || !/^[1-9][0-9]{0,31}$/.test(target.providerAccountId)) {
      throw Object.assign(new Error('A saved account target is unavailable or has changed. Reconnect that account before preparing artwork.'), {
        status: 409,
        code: 'ARTWORK_TARGET_UNAVAILABLE',
        provider: target.provider,
        providerAccountId: target.providerAccountId,
        accountLabel: target.accountLabel,
      });
    }
      const matches = connections.filter((connection) => connection.status === 'connected'
        && connection.provider === target.provider
        && connection.providerAccountId === target.providerAccountId
        && connection.id
        && (!target.accountConnectionId || connection.id === target.accountConnectionId));
      if (matches.length !== 1) {
        throw Object.assign(new Error('A saved account target is unavailable or has changed. Reconnect that account before preparing artwork.'), {
          status: 409,
          code: 'ARTWORK_TARGET_UNAVAILABLE',
          provider: target.provider,
          providerAccountId: target.providerAccountId,
          accountLabel: target.accountLabel,
        });
      }
      return { ...target, accountConnectionId: matches[0].id };
    });
}

function accountSnapshotRevision(row, provider, connections = []) {
  const targets = normalizeSnapshotTargets(row, provider, connections);
  return row && targets.length ? {
    id: cleanString(row.id, 120),
    createdAt: cleanString(row.created_at, 80),
    platform: cleanString(row.preference_value?.platform, 40).toLowerCase(),
    targets,
    payloadHash: sha256Hex(Buffer.from(canonicalJson({ postId: row.preference_value?.postId, platform: row.preference_value?.platform, targets }))),
  } : null;
}

function assertMetaArtworkProvider(provider) {
  if (!META_PROVIDER_KEYS.includes(provider)) {
    throw Object.assign(new Error('Exact rendered Meta artwork review is available only for Meta-connected Facebook and Instagram posts.'), {
      status: 422,
      code: 'ARTWORK_PROVIDER_UNSUPPORTED',
    });
  }
}

function assertCompleteAccountSnapshot(accountSnapshot) {
  if (!accountSnapshot?.targets?.length) {
    throw Object.assign(new Error('Choose at least one current Meta account target before preparing artwork.'), {
      status: 409,
      code: 'ARTWORK_TARGETS_REQUIRED',
    });
  }
  return accountSnapshot;
}

function assertSourceMembership(context, payload) {
  const image = payload.image;
  if (!image) return;
  if (image.kind === 'upload') {
    const asset = context.assets.find((item) => item.storagePath === image.storage_path);
    if (!asset || asset.pod_id !== context.post.podId || asset.assetRole === 'video' || !String(asset.type || '').startsWith('image/')) {
      throw Object.assign(new Error('Choose an image from this pod before preparing artwork.'), { status: 422, code: 'ARTWORK_SOURCE_NOT_APPROVED' });
    }
    if (!image.storage_path.startsWith(`${context.post.userId}/${context.post.podId}/`)) {
      throw Object.assign(new Error('Choose an image from this pod before preparing artwork.'), { status: 403, code: 'ARTWORK_SOURCE_TENANT_MISMATCH' });
    }
    return;
  }
  const source = context.sourceMedia.find((media) => media.url === image.url && (media.source_url || null) === (image.source_url || null) && media.approval_status !== 'rejected');
  if (!source) throw Object.assign(new Error('Choose a reviewed source image before preparing artwork.'), { status: 422, code: 'ARTWORK_SOURCE_NOT_APPROVED' });
}

export async function prepareArtworkReview({
  accessToken,
  user,
  input,
  storage = createSupabasePodAssetStorage(),
  sourceFetcher = createReviewedSourceFetcher(),
  now = Date.now(),
  env = process.env,
} = {}) {
  const podId = cleanString(input?.podId, 120);
  const postId = cleanString(input?.postId, 120);
  if (!podId || !postId) throw Object.assign(new Error('Choose a pod post before preparing artwork.'), { status: 400, code: 'ARTWORK_INPUT_REQUIRED' });
  const context = await loadArtworkReviewContext({ accessToken, userId: user.id, podId, postId });
  assertMetaArtworkProvider(context.post.platform);
  const reviewPayload = buildReviewPayload({ post: context.post, pod: context.pod, input, approved: false });
  const reviewRevision = latestReviewRevision(context.latestCreativeReview);
  const accountSnapshot = assertCompleteAccountSnapshot(accountSnapshotRevision(context.accountSnapshot, context.post.platform, context.metaConnections));
  assertSourceMembership(context, reviewPayload);
  const prepared = await prepareMetaOrganicArtworkReviewEvidence({
    reviewPayload,
    context,
    storage,
    sourceFetcher,
  });
  const tokenPayload = {
    version: PREPARATION_TOKEN_VERSION,
    userId: user.id,
    podId,
    postId,
    provider: context.post.platform,
    contentHash: sha256Hex(Buffer.from(context.post.body)),
    contentSnapshot: context.post.body,
    reviewPayload: prepared.reviewPayload,
    sourceEvidence: prepared.sourceEvidence,
    finalRenderEvidence: prepared.finalRenderEvidence,
    renderHash: prepared.finalRenderEvidence.hash,
    latestReviewRevision: reviewRevision,
    accountSnapshot,
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PREPARATION_TTL_MS).toISOString(),
  };
  return {
    preparationToken: signPreparation(tokenPayload, env),
    preparationId: preparationFingerprint(tokenPayload),
    expiresAt: tokenPayload.expiresAt,
    image: {
      dataUrl: dataUrl(prepared.bytes),
      hash: prepared.finalRenderEvidence.hash,
      byteLength: prepared.finalRenderEvidence.byteLength,
      mediaType: 'image/jpeg',
      dimensions: prepared.finalRenderEvidence.dimensions,
      rendererVersion: META_ORGANIC_ARTWORK_RENDERER_VERSION,
    },
    sourceEvidence: prepared.sourceEvidence,
    accountSnapshotFingerprint: accountSnapshot?.payloadHash || null,
  };
}

function buildNormalizedForAttestation({ context, row, payload }) {
  const sourceEvidence = normalizeMetaOrganicSourceEvidenceForAttestation(payload.source_evidence || {});
  return {
    post: {
      id: context.post.id,
      userId: context.post.userId,
      podId: context.post.podId,
      provider: context.post.platform,
      status: 'approved',
      caption: context.post.body,
      contentVersion: md5Hex(context.post.body),
      contentHash: sha256Hex(Buffer.from(context.post.body)),
    },
    approval: {
      id: row.id,
      rowCreatedAt: row.created_at,
      approvedAt: payload.approved_at,
      contentSnapshot: payload.content_snapshot,
      sourceEvidence,
      finalRenderEvidence: payload.final_render_evidence,
      composition: {
        version: payload.composition.version,
        layout: payload.composition.layout,
        fontContract: payload.composition.font_contract,
        brandName: payload.composition.brand_name,
        imageRole: payload.composition.image_role,
        typographyOnly: payload.composition.typography_only,
        headline: payload.composition.headline,
        callToAction: payload.composition.call_to_action,
      },
    },
  };
}

async function saveCreativePreference(accessToken, podId, payload, context, env, rpc = rpcWithServiceRole) {
  const response = await supabaseAuthedPost('/rest/v1/pod_preferences', accessToken, {
    pod_id: podId,
    preference_type: 'creative_review',
    preference_value: payload,
    source: 'user_override',
    active: true,
  });
  const rows = await readRows(response, 'Creative approval could not be saved.');
  const row = rows[0];
  if (!row?.id || row.pod_id !== podId || row.preference_type !== 'creative_review' || row.active !== true) {
    throw Object.assign(new Error('Creative approval save could not be confirmed.'), { status: 502, code: 'ARTWORK_APPROVAL_UNCONFIRMED' });
  }
  const normalized = buildNormalizedForAttestation({ context, row, payload });
  const approvedAttestationPayload = buildMetaOrganicCreativeApprovalAttestationPayload({
    approvalRow: row,
    approval: payload,
    normalized,
  });
  const attestation = createMetaOrganicCreativeApprovalAttestation({ approvalRow: row, approval: payload, normalized, env });
  const attestedPayload = { ...payload, server_attestation: attestation };
  const updateResponse = await supabaseAuthedPatch(`/rest/v1/pod_preferences?id=eq.${encodeURIComponent(row.id)}`, accessToken, {
    preference_value: attestedPayload,
    updated_at: new Date().toISOString(),
  });
  const updatedRows = await readRows(updateResponse, 'Creative approval attestation could not be saved.');
  const updated = updatedRows[0];
  if (!updated?.id || updated.id !== row.id || updated.preference_value?.server_attestation?.payloadHash !== attestation.payloadHash) {
    throw Object.assign(new Error('Creative approval attestation save could not be confirmed.'), { status: 502, code: 'ARTWORK_APPROVAL_ATTESTATION_UNCONFIRMED' });
  }
  try {
    await rpc('persist_meta_organic_creative_approval_attestation', {
      p_attestation: {
        approvalId: row.id,
        userId: context.post.userId,
        podId,
        postId: context.post.id,
        contentHash: sha256Hex(Buffer.from(context.post.body)),
        sourceHash: payload.source_evidence?.hash || null,
        outputHash: payload.final_render_evidence?.hash,
        payloadHash: attestation.payloadHash,
        signature: attestation.signature,
        version: attestation.version,
        payload: approvedAttestationPayload,
      },
    });
  } catch (error) {
    await supabaseAuthedPatch(`/rest/v1/pod_preferences?id=eq.${encodeURIComponent(row.id)}`, accessToken, {
      active: false,
      preference_value: {
        ...attestedPayload,
        status: 'approval_unavailable',
        approved_at: null,
        server_attestation: null,
        approval_error: error?.code || error?.message || 'ARTWORK_APPROVAL_ATTESTATION_UNAVAILABLE',
      },
      updated_at: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }
  return updated;
}

async function markPostApproved(accessToken, postId) {
  const response = await supabaseAuthedPatch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`, accessToken, {
    status: 'approved',
    updated_at: new Date().toISOString(),
  });
  const rows = await readRows(response, 'Post approval status could not be saved.');
  return rows[0] || null;
}

function sameRevision(left, right) {
  return canonicalJson(left || null) === canonicalJson(right || null);
}

export async function approveArtworkReviewAndExport({
  accessToken,
  user,
  input,
  storage = createSupabasePodAssetStorage(),
  sourceFetcher = createReviewedSourceFetcher(),
  store = createRpcMetaOrganicArtworkExportStore(),
  rpc = rpcWithServiceRole,
  now = Date.now(),
  env = process.env,
} = {}) {
  const token = verifyPreparationToken(input?.preparationToken, env, now);
  if (token.userId !== user.id || token.podId !== cleanString(input?.podId, 120) || token.postId !== cleanString(input?.postId, 120)) {
    throw Object.assign(new Error('Rendered artwork review does not belong to this pod post.'), { status: 403, code: 'ARTWORK_PREPARATION_TENANT_MISMATCH' });
  }
  const context = await loadArtworkReviewContext({ accessToken, userId: user.id, podId: token.podId, postId: token.postId });
  assertMetaArtworkProvider(context.post.platform);
  if (context.post.body !== token.contentSnapshot || sha256Hex(Buffer.from(context.post.body)) !== token.contentHash) {
    throw Object.assign(new Error('The caption changed after render review. Prepare the artwork again.'), { status: 409, code: 'ARTWORK_PREPARATION_STALE' });
  }
  if (!sameRevision(latestReviewRevision(context.latestCreativeReview), token.latestReviewRevision)) {
    throw Object.assign(new Error('A newer creative review exists. Prepare the artwork again.'), { status: 409, code: 'ARTWORK_REVIEW_SUPERSEDED' });
  }
  const accountSnapshot = accountSnapshotRevision(context.accountSnapshot, token.provider, context.metaConnections);
  assertCompleteAccountSnapshot(accountSnapshot);
  if (!sameRevision(accountSnapshot, token.accountSnapshot)) {
    throw Object.assign(new Error('Account targets changed after render review. Prepare the artwork again.'), { status: 409, code: 'ARTWORK_TARGETS_CHANGED' });
  }
  if (input?.accountSnapshotFingerprint && input.accountSnapshotFingerprint !== accountSnapshot?.payloadHash) {
    throw Object.assign(new Error('Account target confirmation is stale. Prepare the artwork again.'), { status: 409, code: 'ARTWORK_TARGETS_CHANGED' });
  }
  const rerendered = await prepareMetaOrganicArtworkReviewEvidence({
    reviewPayload: token.reviewPayload,
    context,
    storage,
    sourceFetcher,
  });
  if (rerendered.finalRenderEvidence.hash !== token.finalRenderEvidence.hash || rerendered.finalRenderEvidence.byteLength !== token.finalRenderEvidence.byteLength) {
    throw Object.assign(new Error('Rendered artwork bytes changed after review. Prepare the artwork again.'), { status: 409, code: 'ARTWORK_RENDER_CHANGED' });
  }
  const approvedAt = new Date(now).toISOString();
  const approvedPayload = {
    ...token.reviewPayload,
    status: 'approved',
    approved_at: approvedAt,
    source_evidence: token.sourceEvidence,
    final_render_evidence: token.finalRenderEvidence,
  };
  await markPostApproved(accessToken, token.postId);
  const row = await saveCreativePreference(accessToken, token.podId, approvedPayload, context, env, rpc);
  const targets = accountSnapshot.targets;
  const exports = [];
  const failures = [];
  for (const target of targets) {
    try {
      const result = await exportApprovedMetaOrganicArtwork({
        request: {
          userId: user.id,
          podId: token.podId,
          postId: token.postId,
          provider: token.provider,
          accountConnectionId: target.accountConnectionId,
          providerAccountId: target.providerAccountId,
          creativeApprovalId: row.id,
        },
        store,
        storage,
        sourceFetcher,
        now: new Date(now),
      });
      if (result.status !== 'exported') {
        failures.push({ provider: token.provider, providerAccountId: target.providerAccountId, accountConnectionId: target.accountConnectionId, reason: result.reason || 'ARTWORK_EXPORT_BLOCKED' });
        continue;
      }
      exports.push({
        provider: token.provider,
        providerAccountId: target.providerAccountId,
        accountConnectionId: result.manifest.authority.accountConnectionId,
        manifestHash: result.manifest.manifestHash,
        outputHash: result.manifest.output.hash,
        providerReadableUrlExpiresAt: result.manifest.output.providerReadableUrlExpiresAt,
      });
    } catch (error) {
      failures.push({ provider: token.provider, providerAccountId: target.providerAccountId, accountConnectionId: target.accountConnectionId, reason: error?.code || error?.message || 'ARTWORK_EXPORT_FAILED' });
    }
  }
  return { approval: row, exports, failures, status: failures.length ? (exports.length ? 'partially_exported' : 'export_blocked') : 'exported' };
}

export async function requireArtworkUser(req) {
  const accessToken = req.accessToken;
  const user = await verifySupabaseUser(accessToken);
  if (!user?.id) throw Object.assign(new Error('Sign in again before reviewing artwork.'), { status: 401, code: 'ARTWORK_AUTH_REQUIRED' });
  return { user, accessToken };
}
