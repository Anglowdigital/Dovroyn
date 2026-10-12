import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { rpcWithServiceRole } from './supabaseAuth.js';

const require = createRequire(import.meta.url);

export const META_ORGANIC_ARTWORK_EXPORT_CONTRACT_VERSION = 'meta_organic_artwork_export_v1';
export const META_ORGANIC_CREATIVE_COMPOSITION_VERSION = 'meta_organic_creative_composition_v2';
export const META_ORGANIC_CREATIVE_LAYOUT = 'meta-organic-portrait-v1';
export const META_ORGANIC_CREATIVE_FONT_CONTRACT = 'system-ui-safe-v1';
export const META_ORGANIC_ARTWORK_RENDERER_VERSION = 'sharp_svg_jpeg_2026_10_12_v1';
export const META_ORGANIC_CREATIVE_APPROVAL_ATTESTATION_VERSION = 'meta_organic_creative_approval_attestation_v1';
export const META_ORGANIC_EXPORT_URL_MIN_TTL_SECONDS = 4 * 60 * 60;
export const META_ORGANIC_EXPORT_URL_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const META_ORGANIC_EXPORT_WIDTH = 1080;
export const META_ORGANIC_EXPORT_HEIGHT = 1350;
export const META_ORGANIC_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export const META_ORGANIC_MAX_SOURCE_PIXELS = 24_000_000;
export const META_ORGANIC_MAX_OUTPUT_BYTES = 3 * 1024 * 1024;

const PROVIDERS = new Set(['facebook', 'instagram']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function iso(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function md5Hex(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return sha256Hex(Buffer.from(canonicalJson(value)));
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function attestationSecret(env = process.env) {
  return env.META_ARTWORK_REVIEW_TOKEN_SECRET || env.META_OAUTH_COOKIE_SECRET || env.META_TOKEN_ENCRYPTION_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
}

export function buildMetaOrganicCreativeApprovalAttestationPayload({ approvalRow, approval, normalized }) {
  return {
    version: META_ORGANIC_CREATIVE_APPROVAL_ATTESTATION_VERSION,
    row: {
      id: cleanString(approvalRow?.id, 120),
      createdAt: iso(approvalRow?.created_at || approvalRow?.createdAt),
      preferenceType: cleanString(approvalRow?.preference_type || approvalRow?.preferenceType, 80),
      active: approvalRow?.active !== false,
    },
    authority: {
      userId: normalized.post.userId,
      podId: normalized.post.podId,
      postId: normalized.post.id,
      provider: normalized.post.provider,
      contentHash: normalized.post.contentHash,
      contentVersion: normalized.post.contentVersion,
      approvedAt: iso(normalized.approval.approvedAt),
    },
    composition: normalized.approval.composition,
    image: approval.image || null,
    sourceEvidence: normalized.approval.sourceEvidence,
    finalRenderEvidence: normalized.approval.finalRenderEvidence,
  };
}

export function createMetaOrganicCreativeApprovalAttestation({ approvalRow, approval, normalized, env = process.env }) {
  const secret = attestationSecret(env);
  if (!secret) throw Object.assign(new Error('Creative approval attestation is not configured.'), { code: 'EXPORT_APPROVAL_ATTESTATION_UNAVAILABLE' });
  const payload = buildMetaOrganicCreativeApprovalAttestationPayload({ approvalRow, approval, normalized });
  const payloadHash = hashJson(payload);
  return {
    version: META_ORGANIC_CREATIVE_APPROVAL_ATTESTATION_VERSION,
    payloadHash,
    signature: hmac(payloadHash, secret),
  };
}

function verifyMetaOrganicCreativeApprovalAttestation({ approvalRow, approval, normalized }) {
  const attestation = approval.server_attestation || approval.serverAttestation;
  const secret = attestationSecret();
  if (!secret || attestation?.version !== META_ORGANIC_CREATIVE_APPROVAL_ATTESTATION_VERSION) return false;
  const expected = createMetaOrganicCreativeApprovalAttestation({ approvalRow, approval, normalized });
  const left = Buffer.from(cleanString(attestation.signature, 200));
  const right = Buffer.from(expected.signature);
  return attestation.payloadHash === expected.payloadHash
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function manifestHashPayload(manifest) {
  return {
    contractVersion: manifest.contractVersion,
    authority: manifest.authority,
    composition: manifest.composition,
    source: {
      kind: manifest.source?.kind,
      identity: manifest.source?.identity,
      sourceUrl: manifest.source?.sourceUrl || null,
      hash: manifest.source?.hash || null,
      objectVersion: manifest.source?.objectVersion || null,
      revision: manifest.source?.revision || null,
      mediaType: manifest.source?.mediaType || null,
      byteLength: manifest.source?.byteLength || 0,
    },
    output: {
      hash: manifest.output?.hash,
      mediaType: manifest.output?.mediaType,
      dimensions: manifest.output?.dimensions,
      byteLength: manifest.output?.byteLength,
      objectPath: manifest.output?.objectPath,
      providerReadableUrl: manifest.output?.providerReadableUrl,
      providerReadableUrlExpiresAt: manifest.output?.providerReadableUrlExpiresAt,
    },
  };
}

export function computeMetaOrganicArtworkManifestHash(manifest) {
  return hashJson(manifestHashPayload(manifest));
}

function requireId(value, field) {
  const id = cleanString(value, 120);
  if (!id) throw Object.assign(new Error(`${field} is required.`), { code: 'EXPORT_INPUT_REQUIRED' });
  return id;
}

function normalizeProvider(value) {
  const provider = cleanString(value, 40).toLowerCase();
  return PROVIDERS.has(provider) ? provider : '';
}

function providerAccountId(value) {
  const id = cleanString(value, 80);
  return /^[1-9][0-9]{0,31}$/.test(id) ? id : '';
}

function mediaType(value) {
  const type = cleanString(value, 80).toLowerCase().split(';')[0];
  return IMAGE_TYPES.has(type) ? type : '';
}

function unsafeIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function wrapText(value, { maxChars, maxLines }) {
  const words = cleanString(value, 600).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > maxChars ? `${word.slice(0, Math.max(1, maxChars - 1))}.` : word;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.join(' ').length > lines.join(' ').length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.\s]+$/, '')}.`;
  }
  return lines;
}

function normalizeAccountTarget(target = {}, expectedProvider = '') {
  const provider = normalizeProvider(target.provider || target.platform || expectedProvider);
  const id = providerAccountId(target.providerAccountId || target.provider_account_id || target.accountId);
  const accountConnectionId = cleanString(target.accountConnectionId || target.account_connection_id || target.connectionId, 120);
  if (!provider || (expectedProvider && provider !== expectedProvider) || !id) return null;
  return {
    provider,
    providerAccountId: id,
    ...(accountConnectionId ? { accountConnectionId } : {}),
    ...(cleanString(target.accountLabel || target.account_label || target.label, 200) ? { accountLabel: cleanString(target.accountLabel || target.account_label || target.label, 200) } : {}),
  };
}

function normalizeImageReference(reference) {
  if (reference == null) return null;
  if (reference?.kind === 'upload') {
    const storagePath = cleanString(reference.storage_path || reference.storagePath, 700);
    if (!storagePath) throw Object.assign(new Error('Approved upload artwork is missing its storage path.'), { code: 'EXPORT_SOURCE_REQUIRED' });
    return { kind: 'upload', storagePath };
  }
  if (reference?.kind === 'source') {
    let url;
    try { url = new URL(String(reference.url || '')); } catch {
      throw Object.assign(new Error('Approved source artwork URL is invalid.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw Object.assign(new Error('Approved source artwork URL is not eligible.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const ipVersion = isIP(host);
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || (ipVersion === 4 && unsafeIpv4(host))
      || (ipVersion === 6 && (!/^[23]/.test(host) || host.startsWith('2001:db8:')))) {
      throw Object.assign(new Error('Approved source artwork URL is not public.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
    }
    return {
      kind: 'source',
      url: url.toString(),
      sourceUrl: cleanString(reference.source_url || reference.sourceUrl, 1000) || null,
    };
  }
  throw Object.assign(new Error('Approved artwork source is not recognized.'), { code: 'EXPORT_SOURCE_REQUIRED' });
}

function normalizeComposition(approval, context) {
  const composition = approval.composition || {};
  if (approval.artwork_contract_version !== META_ORGANIC_CREATIVE_COMPOSITION_VERSION
    || composition.version !== META_ORGANIC_CREATIVE_COMPOSITION_VERSION
    || composition.layout !== META_ORGANIC_CREATIVE_LAYOUT
    || composition.font_contract !== META_ORGANIC_CREATIVE_FONT_CONTRACT) {
    return { ok: false, reason: 'EXPORT_COMPOSITION_REVIEW_REQUIRED' };
  }
  const headline = cleanString(composition.headline, 350);
  if (!headline || headline !== cleanString(approval.headline, 350)) return { ok: false, reason: 'EXPORT_COMPOSITION_CHANGED' };
  const callToAction = cleanString(composition.call_to_action ?? composition.callToAction, 80);
  if (callToAction !== cleanString(approval.call_to_action || approval.callToAction, 80)) return { ok: false, reason: 'EXPORT_COMPOSITION_CHANGED' };
  const imageRole = cleanString(composition.image_role || composition.imageRole, 40);
  const typographyOnly = composition.typography_only === true || composition.typographyOnly === true;
  if (!['image', 'logo', 'typography'].includes(imageRole)) return { ok: false, reason: 'EXPORT_COMPOSITION_CHANGED' };
  if (typographyOnly !== !approval.image || (typographyOnly && imageRole !== 'typography')) return { ok: false, reason: 'EXPORT_COMPOSITION_CHANGED' };
  return {
    ok: true,
    composition: {
      version: META_ORGANIC_CREATIVE_COMPOSITION_VERSION,
      layout: META_ORGANIC_CREATIVE_LAYOUT,
      fontContract: META_ORGANIC_CREATIVE_FONT_CONTRACT,
      brandName: cleanString(composition.brand_name || composition.brandName || context.pod?.brand_name || context.pod?.brandName || context.pod?.pod_name || context.pod?.podName, 120),
      imageRole,
      typographyOnly,
      headline,
      callToAction,
    },
  };
}

function normalizeSourceEvidence(evidence, reference) {
  if (!reference) {
    if (evidence?.kind !== 'typography_only') return { ok: false, reason: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' };
    return { ok: true, evidence: { kind: 'typography_only', identity: 'typography-only', hash: null, mediaType: null, byteLength: 0 } };
  }
  if (!evidence || evidence.kind !== reference.kind) return { ok: false, reason: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' };
  const hash = cleanString(evidence.hash || evidence.sha256, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return { ok: false, reason: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' };
  const byteLength = Number(evidence.byte_length ?? evidence.byteLength ?? 0);
  if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > META_ORGANIC_MAX_SOURCE_BYTES) return { ok: false, reason: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' };
  const type = mediaType(evidence.media_type || evidence.mediaType || evidence.content_type || evidence.contentType);
  if (!type) return { ok: false, reason: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' };
  if (reference.kind === 'upload') {
    const storagePath = cleanString(evidence.storage_path || evidence.storagePath || evidence.identity, 700);
    const objectVersion = cleanString(evidence.object_version || evidence.objectVersion || evidence.revision, 200);
    if (storagePath !== reference.storagePath || !objectVersion) return { ok: false, reason: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' };
    return { ok: true, evidence: { kind: 'upload', identity: storagePath, hash, mediaType: type, byteLength, objectVersion } };
  }
  const url = cleanString(evidence.url || evidence.identity, 1000);
  const revision = cleanString(evidence.revision || evidence.source_revision || evidence.sourceRevision, 200);
  if (url !== reference.url || !revision) return { ok: false, reason: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' };
  return { ok: true, evidence: { kind: 'source', identity: url, sourceUrl: reference.sourceUrl, hash, mediaType: type, byteLength, revision } };
}

export function normalizeMetaOrganicSourceEvidenceForAttestation(evidence = {}) {
  if (evidence.kind === 'upload') {
    return {
      kind: 'upload',
      identity: cleanString(evidence.storage_path || evidence.storagePath || evidence.identity, 700),
      hash: cleanString(evidence.hash || evidence.sha256, 80).toLowerCase(),
      mediaType: mediaType(evidence.media_type || evidence.mediaType || evidence.content_type || evidence.contentType),
      byteLength: Number(evidence.byte_length ?? evidence.byteLength ?? 0),
      objectVersion: cleanString(evidence.object_version || evidence.objectVersion || evidence.revision, 200),
    };
  }
  if (evidence.kind === 'source') {
    return {
      kind: 'source',
      identity: cleanString(evidence.url || evidence.identity, 1000),
      sourceUrl: cleanString(evidence.source_url || evidence.sourceUrl, 1000) || null,
      hash: cleanString(evidence.hash || evidence.sha256, 80).toLowerCase(),
      mediaType: mediaType(evidence.media_type || evidence.mediaType || evidence.content_type || evidence.contentType),
      byteLength: Number(evidence.byte_length ?? evidence.byteLength ?? 0),
      revision: cleanString(evidence.revision || evidence.source_revision || evidence.sourceRevision, 200),
    };
  }
  return { kind: 'typography_only', identity: 'typography-only', hash: null, mediaType: null, byteLength: 0 };
}

function normalizeFinalRenderEvidence(evidence) {
  const hash = cleanString(evidence?.hash || evidence?.outputHash, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)
    || evidence?.mediaType !== 'image/jpeg'
    || evidence?.rendererVersion !== META_ORGANIC_ARTWORK_RENDERER_VERSION
    || evidence?.dimensions?.width !== META_ORGANIC_EXPORT_WIDTH
    || evidence?.dimensions?.height !== META_ORGANIC_EXPORT_HEIGHT
    || !Number.isInteger(Number(evidence?.byteLength)) || Number(evidence.byteLength) <= 0) {
    return null;
  }
  return {
    hash,
    mediaType: 'image/jpeg',
    dimensions: { width: META_ORGANIC_EXPORT_WIDTH, height: META_ORGANIC_EXPORT_HEIGHT },
    byteLength: Number(evidence.byteLength),
    rendererVersion: META_ORGANIC_ARTWORK_RENDERER_VERSION,
  };
}

export function buildMetaOrganicArtworkExportRequest(input = {}) {
  const provider = normalizeProvider(input.provider);
  if (!provider) throw Object.assign(new Error('A supported Meta organic provider is required.'), { code: 'EXPORT_PROVIDER_REQUIRED' });
  const providerTarget = normalizeAccountTarget(input.account || input.target || input.accountTarget || input, provider);
  if (!providerTarget) throw Object.assign(new Error('A provider account target is required.'), { code: 'EXPORT_ACCOUNT_TARGET_REQUIRED' });
  return {
    contractVersion: META_ORGANIC_ARTWORK_EXPORT_CONTRACT_VERSION,
    userId: requireId(input.userId, 'userId'),
    podId: requireId(input.podId, 'podId'),
    postId: requireId(input.postId || input.draftId, 'postId'),
    provider,
    accountConnectionId: cleanString(input.accountConnectionId || providerTarget.accountConnectionId, 120) || null,
    providerAccountId: providerTarget.providerAccountId,
    creativeApprovalId: requireId(input.creativeApprovalId || input.approvalId, 'creativeApprovalId'),
  };
}

function normalizeApprovedContext(context = {}, request) {
  const post = context.post || context.draft || {};
  const approvalRow = context.approvalRow || context.preference || {};
  const approval = context.approval || approvalRow.preference_value || approvalRow.preferenceValue || {};
  const account = context.account || context.target || {};
  const provider = normalizeProvider(post.platform || post.platformKey || request.provider);
  const postId = cleanString(post.id || post.postId, 120);
  const userId = cleanString(post.userId || post.user_id || context.userId || request.userId, 120);
  const podId = cleanString(post.podId || post.pod_id || approvalRow.pod_id || context.podId || request.podId, 120);
  const rawCaption = post.body ?? post.content ?? post.caption;
  const status = cleanString(post.status, 40).toLowerCase();
  const maxCaptionLength = request.provider === 'instagram' ? 2200 : 63206;
  if (request.contractVersion !== META_ORGANIC_ARTWORK_EXPORT_CONTRACT_VERSION) return { ok: false, reason: 'EXPORT_CONTRACT_VERSION_REQUIRED' };
  if (userId !== request.userId || podId !== request.podId || postId !== request.postId || provider !== request.provider) return { ok: false, reason: 'EXPORT_TENANT_MISMATCH' };
  if (!['approved', 'scheduled'].includes(status)) return { ok: false, reason: 'EXPORT_POST_NOT_APPROVED' };
  if (typeof rawCaption !== 'string' || rawCaption.length === 0) return { ok: false, reason: 'EXPORT_CAPTION_REQUIRED' };
  if (rawCaption.length > maxCaptionLength) return { ok: false, reason: 'EXPORT_CAPTION_TOO_LONG' };
  const approvalId = cleanString(approval.id || approvalRow.id, 120);
  const latestApprovalRow = context.latestApprovalRow || context.latestPreference || null;
  const latestApproval = latestApprovalRow?.preference_value || latestApprovalRow?.preferenceValue || null;
  if (latestApprovalRow) {
    const latestId = cleanString(latestApproval?.id || latestApprovalRow.id, 120);
    if (latestId !== approvalId || cleanString(latestApproval?.post_id || latestApproval?.postId, 120) !== request.postId) {
      return { ok: false, reason: 'EXPORT_APPROVAL_SUPERSEDED' };
    }
  }
  if (approvalId !== request.creativeApprovalId || approvalRow.active === false || cleanString(approvalRow.preference_type || approvalRow.preferenceType, 80) !== 'creative_review') return { ok: false, reason: 'EXPORT_APPROVAL_CHANGED' };
  if (cleanString(approval.post_id || approval.postId, 120) !== request.postId || cleanString(approval.status, 40) !== 'approved') return { ok: false, reason: 'EXPORT_APPROVAL_CHANGED' };
  if (approval.content_snapshot !== rawCaption || !iso(approval.approved_at || approval.approvedAt)) return { ok: false, reason: 'EXPORT_APPROVAL_STALE' };
  const composition = normalizeComposition(approval, context);
  if (!composition.ok) return { ok: false, reason: composition.reason };
  const target = normalizeAccountTarget(account, request.provider);
  if (!target || !target.accountConnectionId || target.providerAccountId !== request.providerAccountId || (request.accountConnectionId && cleanString(target.accountConnectionId, 120) !== request.accountConnectionId)) return { ok: false, reason: 'EXPORT_ACCOUNT_TARGET_CHANGED' };
  const resolvedRequest = { ...request, accountConnectionId: target.accountConnectionId };
  let sourceReference;
  try {
    sourceReference = normalizeImageReference(approval.image || null);
  } catch (error) {
    return { ok: false, reason: error.code || 'EXPORT_SOURCE_REQUIRED' };
  }
  const sourceEvidence = normalizeSourceEvidence(approval.source_evidence || approval.sourceEvidence, sourceReference);
  if (!sourceEvidence.ok) return { ok: false, reason: sourceEvidence.reason };
  const finalRenderEvidence = normalizeFinalRenderEvidence(approval.final_render_evidence || approval.finalRenderEvidence);
  if (!finalRenderEvidence) return { ok: false, reason: 'EXPORT_RENDER_REVIEW_REQUIRED' };
  if (sourceReference?.kind === 'upload') {
    const upload = list(context.assets).find((asset) => cleanString(asset.storagePath || asset.storage_path, 700) === sourceReference.storagePath);
    if (!upload || (upload.pod_id && upload.pod_id !== request.podId) || (upload.user_id && upload.user_id !== request.userId)
      || cleanString(upload.assetRole || upload.asset_role, 40) === 'video' || !mediaType(upload.type || upload.media_type || upload.content_type || upload.mediaType || 'image/jpeg')) {
      return { ok: false, reason: 'EXPORT_SOURCE_NOT_APPROVED' };
    }
  }
  if (sourceReference?.kind === 'source') {
    const source = list(context.sourceMedia || context.source_media).find((media) => cleanString(media.url, 1000) === sourceReference.url
      && cleanString(media.source_url || media.sourceUrl, 1000) === cleanString(sourceReference.sourceUrl, 1000)
      && cleanString(media.approval_status || media.approvalStatus, 40) !== 'rejected');
    if (!source) return { ok: false, reason: 'EXPORT_SOURCE_NOT_APPROVED' };
  }
  const normalized = {
      request,
      post: { id: postId, userId, podId, provider, status, caption: rawCaption, contentVersion: md5Hex(rawCaption), contentHash: sha256Hex(Buffer.from(rawCaption)) },
      approval: {
        id: approvalId,
        rowCreatedAt: iso(approvalRow.created_at || approvalRow.createdAt),
        approvedAt: iso(approval.approved_at || approval.approvedAt),
        headline: composition.composition.headline,
        callToAction: composition.composition.callToAction,
        contentSnapshot: approval.content_snapshot,
        sourceReference,
        sourceEvidence: sourceEvidence.evidence,
        finalRenderEvidence,
        composition: composition.composition,
      },
      request: resolvedRequest,
      accountTarget: target,
      pod: {
        brandName: composition.composition.brandName || cleanString(context.pod?.brand_name || context.pod?.brandName || context.pod?.pod_name || context.pod?.podName, 120) || 'Dovroyn Pod',
      },
  };
  if (!verifyMetaOrganicCreativeApprovalAttestation({ approvalRow, approval, normalized })) return { ok: false, reason: 'EXPORT_APPROVAL_ATTESTATION_REQUIRED' };
  return { ok: true, normalized };
}

function assertSourceBytes(source) {
  const bytes = Buffer.isBuffer(source?.bytes) ? source.bytes : Buffer.from(source?.bytes || []);
  const type = mediaType(source?.contentType || source?.mediaType);
  if (!bytes.byteLength || bytes.byteLength > META_ORGANIC_MAX_SOURCE_BYTES || !type) {
    throw Object.assign(new Error('Artwork source image is not an eligible bounded image.'), { code: 'EXPORT_SOURCE_IMAGE_INVALID' });
  }
  return { ...source, bytes, contentType: type };
}

async function loadSourceImageBytes(context, storage, sourceFetcher) {
  const reference = context.approval.sourceReference;
  if (!reference) {
    return {
      bytes: null,
      source: { ...context.approval.sourceEvidence },
    };
  }
  if (reference.kind === 'upload') {
    if (!reference.storagePath.startsWith(`${context.post.userId}/${context.post.podId}/`)) {
      throw Object.assign(new Error('Approved upload artwork is outside the pod storage namespace.'), { code: 'EXPORT_SOURCE_TENANT_MISMATCH' });
    }
    if (!storage || typeof storage.readPodAsset !== 'function') throw Object.assign(new Error('Pod asset storage adapter is required.'), { code: 'EXPORT_STORAGE_REQUIRED' });
    const source = assertSourceBytes(await storage.readPodAsset({ userId: context.post.userId, podId: context.post.podId, storagePath: reference.storagePath }));
    if (sha256Hex(source.bytes) !== context.approval.sourceEvidence.hash || source.bytes.byteLength !== context.approval.sourceEvidence.byteLength || source.contentType !== context.approval.sourceEvidence.mediaType) {
      throw Object.assign(new Error('Approved upload source bytes changed after review.'), { code: 'EXPORT_SOURCE_BYTES_CHANGED' });
    }
    return {
      bytes: source.bytes,
      source: { ...context.approval.sourceEvidence },
    };
  }
  if (!sourceFetcher || typeof sourceFetcher.fetchReviewedSourceImage !== 'function') {
    throw Object.assign(new Error('Reviewed public source image fetcher is required.'), { code: 'EXPORT_SOURCE_FETCHER_REQUIRED' });
  }
  const fetched = assertSourceBytes(await sourceFetcher.fetchReviewedSourceImage({
    userId: context.post.userId,
    podId: context.post.podId,
    postId: context.post.id,
    url: reference.url,
    sourceUrl: reference.sourceUrl,
  }));
  if (sha256Hex(fetched.bytes) !== context.approval.sourceEvidence.hash || fetched.bytes.byteLength !== context.approval.sourceEvidence.byteLength || fetched.contentType !== context.approval.sourceEvidence.mediaType) {
    throw Object.assign(new Error('Approved source image bytes changed after review.'), { code: 'EXPORT_SOURCE_BYTES_CHANGED' });
  }
  return {
    bytes: fetched.bytes,
    source: { ...context.approval.sourceEvidence },
  };
}

async function loadSharp() {
  const sharp = require('sharp');
  sharp.cache(false);
  sharp.concurrency(1);
  return sharp;
}

export async function renderMetaOrganicArtworkJpeg(composition, options = {}) {
  const sharp = await loadSharp();
  const width = options.width || META_ORGANIC_EXPORT_WIDTH;
  const height = options.height || META_ORGANIC_EXPORT_HEIGHT;
  const hasImage = Buffer.isBuffer(composition.sourceImageBytes) && composition.sourceImageBytes.byteLength > 0;
  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 247, g: 244, b: 237 },
    },
  });
  const composites = [];
  if (hasImage) {
    const meta = await sharp(composition.sourceImageBytes, { limitInputPixels: META_ORGANIC_MAX_SOURCE_PIXELS }).metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > META_ORGANIC_MAX_SOURCE_PIXELS) {
      throw Object.assign(new Error('Artwork source image exceeds pixel limits.'), { code: 'EXPORT_SOURCE_IMAGE_INVALID' });
    }
    const imageHeight = Math.round(height * 0.62);
    const imageFit = composition.imageRole === 'logo' ? 'contain' : 'cover';
    const resized = await sharp(composition.sourceImageBytes, { limitInputPixels: META_ORGANIC_MAX_SOURCE_PIXELS })
      .rotate()
      .resize(width, imageHeight, { fit: imageFit, position: 'attention', background: { r: 247, g: 244, b: 237 } })
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: false })
      .toBuffer();
    composites.push({ input: resized, left: 0, top: 0 });
  }
  const textTop = hasImage ? Math.round(height * 0.67) : Math.round(height * 0.22);
  const headlineLines = wrapText(composition.headline, { maxChars: 24, maxLines: hasImage ? 3 : 5 });
  const cta = cleanString(composition.callToAction, 80);
  const brand = cleanString(composition.brandName, 120);
  const brandSvg = brand ? `<text x="78" y="${hasImage ? 76 : 128}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#172033">${escapeXml(brand)}</text>` : '';
  const headlineTspans = headlineLines.map((line, index) => `<tspan x="78" dy="${index === 0 ? 0 : 72}">${escapeXml(line)}</tspan>`).join('');
  const ctaSvg = cta ? `<rect x="78" y="${height - 154}" width="${Math.min(510, Math.max(240, cta.length * 18 + 86))}" height="72" rx="0" fill="#17324d"/><text x="122" y="${height - 106}" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" fill="#fff">${escapeXml(cta)}</text>` : '';
  const svg = Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" fill="none"/>
    ${brandSvg}
    <text x="78" y="${textTop}" font-family="Arial, Helvetica, sans-serif" font-size="${hasImage ? 66 : 82}" font-weight="700" fill="#172033">${headlineTspans}</text>
    ${ctaSvg}
  </svg>`);
  composites.push({ input: svg, left: 0, top: 0 });
  const output = await base.composite(composites).jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
  if (output.byteLength > META_ORGANIC_MAX_OUTPUT_BYTES) throw Object.assign(new Error('Rendered artwork exceeds output size limits.'), { code: 'EXPORT_OUTPUT_TOO_LARGE' });
  const outputMeta = await sharp(output, { limitInputPixels: META_ORGANIC_MAX_SOURCE_PIXELS }).metadata();
  if (outputMeta.format !== 'jpeg' || outputMeta.width !== width || outputMeta.height !== height) {
    throw Object.assign(new Error('Rendered artwork did not match the JPEG contract.'), { code: 'EXPORT_RENDER_CONTRACT_MISMATCH' });
  }
  return output;
}

export async function prepareMetaOrganicArtworkReviewEvidence({
  reviewPayload,
  context,
  storage,
  sourceFetcher,
  renderer = renderMetaOrganicArtworkJpeg,
} = {}) {
  const post = context?.post || context?.draft || {};
  const rawCaption = post.body ?? post.content ?? post.caption;
  if (typeof rawCaption !== 'string' || rawCaption.length === 0) throw Object.assign(new Error('Post caption is required before preparing artwork review evidence.'), { code: 'EXPORT_CAPTION_REQUIRED' });
  const approval = {
    ...reviewPayload,
    status: 'approved',
    approved_at: reviewPayload?.approved_at || new Date().toISOString(),
  };
  const composition = normalizeComposition(approval, context || {});
  if (!composition.ok) throw Object.assign(new Error(composition.reason), { code: composition.reason });
  const reference = normalizeImageReference(approval.image || null);
  let sourceImageBytes = null;
  let sourceEvidence;
  if (!reference) {
    sourceEvidence = { kind: 'typography_only', identity: 'typography-only', hash: null, mediaType: null, byteLength: 0 };
  } else if (reference.kind === 'upload') {
    if (!storage || typeof storage.readPodAsset !== 'function') throw Object.assign(new Error('Pod asset storage adapter is required.'), { code: 'EXPORT_STORAGE_REQUIRED' });
    const source = assertSourceBytes(await storage.readPodAsset({
      userId: cleanString(post.userId || post.user_id || context?.userId, 120),
      podId: cleanString(post.podId || post.pod_id || context?.podId, 120),
      storagePath: reference.storagePath,
    }));
    const objectVersion = cleanString(source.objectVersion || source.object_version || source.etag || source.eTag, 200);
    if (!objectVersion) throw Object.assign(new Error('Upload object version is required to freeze artwork review evidence.'), { code: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' });
    sourceImageBytes = source.bytes;
    sourceEvidence = { kind: 'upload', storage_path: reference.storagePath, identity: reference.storagePath, hash: sha256Hex(source.bytes), object_version: objectVersion, media_type: source.contentType, byte_length: source.bytes.byteLength };
  } else {
    if (!sourceFetcher || typeof sourceFetcher.fetchReviewedSourceImage !== 'function') throw Object.assign(new Error('Reviewed public source image fetcher is required.'), { code: 'EXPORT_SOURCE_FETCHER_REQUIRED' });
    const fetched = assertSourceBytes(await sourceFetcher.fetchReviewedSourceImage({ url: reference.url, sourceUrl: reference.sourceUrl }));
    const revision = cleanString(fetched.revision || fetched.sourceRevision || fetched.etag || fetched.eTag || fetched.lastModified, 200);
    if (!revision) throw Object.assign(new Error('Source image revision is required to freeze artwork review evidence.'), { code: 'EXPORT_SOURCE_EVIDENCE_REQUIRED' });
    sourceImageBytes = fetched.bytes;
    sourceEvidence = { kind: 'source', url: reference.url, source_url: reference.sourceUrl, identity: reference.url, hash: sha256Hex(fetched.bytes), revision, media_type: fetched.contentType, byte_length: fetched.bytes.byteLength };
  }
  const bytes = Buffer.from(await renderer({
    headline: composition.composition.headline,
    callToAction: composition.composition.callToAction,
    caption: rawCaption,
    brandName: composition.composition.brandName,
    imageRole: composition.composition.imageRole,
    sourceImageBytes,
  }));
  const finalRenderEvidence = {
    hash: sha256Hex(bytes),
    mediaType: 'image/jpeg',
    dimensions: { width: META_ORGANIC_EXPORT_WIDTH, height: META_ORGANIC_EXPORT_HEIGHT },
    byteLength: bytes.byteLength,
    rendererVersion: META_ORGANIC_ARTWORK_RENDERER_VERSION,
  };
  return {
    reviewPayload: {
      ...reviewPayload,
      source_evidence: sourceEvidence,
      final_render_evidence: finalRenderEvidence,
    },
    bytes,
    sourceEvidence,
    finalRenderEvidence,
  };
}

function buildManifest({ context, source, outputBytes, objectPath, signedUrl, signedUrlExpiresAt, rendererVersion, now }) {
  const outputHash = sha256Hex(outputBytes);
  const output = {
    hash: outputHash,
    mediaType: 'image/jpeg',
    dimensions: { width: META_ORGANIC_EXPORT_WIDTH, height: META_ORGANIC_EXPORT_HEIGHT },
    byteLength: outputBytes.byteLength,
    objectPath,
    providerReadableUrl: signedUrl,
    providerReadableUrlExpiresAt: signedUrlExpiresAt,
  };
  const authority = {
    userId: context.post.userId,
    podId: context.post.podId,
    postId: context.post.id,
    provider: context.post.provider,
    accountConnectionId: context.request.accountConnectionId,
    providerAccountId: context.request.providerAccountId,
    creativeApprovalId: context.approval.id,
    approvedAt: context.approval.approvedAt,
    contentVersion: context.post.contentVersion,
    contentHash: context.post.contentHash,
    sourceIdentity: source.identity,
    sourceHash: source.hash,
    sourceKind: source.kind,
    rendererVersion,
  };
  const manifest = {
    contractVersion: META_ORGANIC_ARTWORK_EXPORT_CONTRACT_VERSION,
    status: 'exported',
    immutable: true,
    createdAt: iso(now) || new Date(now).toISOString(),
    authority,
    composition: {
      ...context.approval.composition,
      captionSnapshot: context.post.caption,
      brandName: context.pod.brandName,
    },
    source,
    output,
  };
  manifest.manifestHash = computeMetaOrganicArtworkManifestHash(manifest);
  return manifest;
}

export function validateMetaOrganicArtworkManifest(manifest = {}, now = new Date()) {
  if (manifest.contractVersion !== META_ORGANIC_ARTWORK_EXPORT_CONTRACT_VERSION || manifest.status !== 'exported' || manifest.immutable !== true) return { ok: false, reason: 'EXPORT_MANIFEST_CONTRACT_REQUIRED' };
  if (manifest.manifestHash !== computeMetaOrganicArtworkManifestHash(manifest)) return { ok: false, reason: 'EXPORT_MANIFEST_HASH_MISMATCH' };
  const authority = manifest.authority || {};
  const output = manifest.output || {};
  const source = manifest.source || {};
  const composition = manifest.composition || {};
  if (!cleanString(authority.userId, 120) || !cleanString(authority.podId, 120) || !cleanString(authority.postId, 120)
    || !normalizeProvider(authority.provider) || !cleanString(authority.accountConnectionId, 120) || !providerAccountId(authority.providerAccountId)
    || !cleanString(authority.creativeApprovalId, 120) || !cleanString(authority.contentVersion, 120)
    || !/^[a-f0-9]{64}$/.test(cleanString(authority.contentHash, 80)) || authority.rendererVersion !== META_ORGANIC_ARTWORK_RENDERER_VERSION) {
    return { ok: false, reason: 'EXPORT_MANIFEST_AUTHORITY_REQUIRED' };
  }
  if (composition.version !== META_ORGANIC_CREATIVE_COMPOSITION_VERSION || composition.layout !== META_ORGANIC_CREATIVE_LAYOUT || composition.fontContract !== META_ORGANIC_CREATIVE_FONT_CONTRACT) return { ok: false, reason: 'EXPORT_MANIFEST_COMPOSITION_REQUIRED' };
  if (!['upload', 'source', 'typography_only'].includes(source.kind) || (source.kind !== 'typography_only' && !/^[a-f0-9]{64}$/.test(cleanString(source.hash, 80)))) return { ok: false, reason: 'EXPORT_MANIFEST_SOURCE_REQUIRED' };
  if (!/^[a-f0-9]{64}$/.test(cleanString(output.hash, 80)) || output.mediaType !== 'image/jpeg'
    || output.dimensions?.width !== META_ORGANIC_EXPORT_WIDTH || output.dimensions?.height !== META_ORGANIC_EXPORT_HEIGHT
    || !Number.isInteger(output.byteLength) || output.byteLength <= 0 || output.byteLength > META_ORGANIC_MAX_OUTPUT_BYTES
    || cleanString(output.objectPath, 1200) !== `meta-organic-exports/${authority.userId}/${authority.podId}/${authority.postId}/${authority.creativeApprovalId}/${authority.accountConnectionId}/${output.hash}.jpg`
    || !/^https:\/\//i.test(output.providerReadableUrl || '') || !iso(output.providerReadableUrlExpiresAt) || Date.parse(output.providerReadableUrlExpiresAt) - new Date(now).getTime() < META_ORGANIC_EXPORT_URL_MIN_TTL_SECONDS * 1000) {
    return { ok: false, reason: 'EXPORT_MANIFEST_OUTPUT_REQUIRED' };
  }
  return { ok: true };
}

export async function exportApprovedMetaOrganicArtwork({
  request,
  store,
  storage,
  sourceFetcher,
  renderer = renderMetaOrganicArtworkJpeg,
  now = new Date(),
  signedUrlTtlSeconds = META_ORGANIC_EXPORT_URL_MIN_TTL_SECONDS,
} = {}) {
  const normalizedRequest = buildMetaOrganicArtworkExportRequest(request);
  if (!store || typeof store.loadApprovedArtworkContext !== 'function' || typeof store.persistExportManifest !== 'function') {
    throw Object.assign(new Error('Artwork export store adapter is required.'), { code: 'EXPORT_STORE_REQUIRED' });
  }
  if (!storage || typeof storage.putImmutableObject !== 'function' || typeof storage.createReadOnlySignedUrl !== 'function') {
    throw Object.assign(new Error('Artwork export storage adapter is required.'), { code: 'EXPORT_STORAGE_REQUIRED' });
  }
  const rawContext = await store.loadApprovedArtworkContext(normalizedRequest);
  if (!rawContext) return { status: 'blocked', reason: 'EXPORT_CONTEXT_UNAVAILABLE' };
  const contextResult = normalizeApprovedContext(rawContext, normalizedRequest);
  if (!contextResult.ok) return { status: 'blocked', reason: contextResult.reason };
  const context = contextResult.normalized;
  const { bytes: sourceImageBytes, source } = await loadSourceImageBytes(context, storage, sourceFetcher);
  const outputBytes = Buffer.from(await renderer({
    headline: context.approval.headline,
    callToAction: context.approval.callToAction,
    caption: context.post.caption,
    brandName: context.pod.brandName,
    imageRole: context.approval.composition.imageRole,
    sourceImageBytes,
  }));
  const outputHash = sha256Hex(outputBytes);
  if (outputHash !== context.approval.finalRenderEvidence.hash || outputBytes.byteLength !== context.approval.finalRenderEvidence.byteLength) {
    throw Object.assign(new Error('Rendered artwork no longer matches the explicitly reviewed JPEG bytes.'), { code: 'EXPORT_RENDER_BYTES_CHANGED' });
  }
  const objectPath = `meta-organic-exports/${context.post.userId}/${context.post.podId}/${context.post.id}/${context.approval.id}/${context.request.accountConnectionId}/${outputHash}.jpg`;
  await storage.putImmutableObject(objectPath, outputBytes, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
  const ttl = Math.max(META_ORGANIC_EXPORT_URL_MIN_TTL_SECONDS, Math.min(META_ORGANIC_EXPORT_URL_MAX_TTL_SECONDS, Number(signedUrlTtlSeconds) || META_ORGANIC_EXPORT_URL_MIN_TTL_SECONDS));
  const signed = await storage.createReadOnlySignedUrl(objectPath, ttl);
  const signedUrl = cleanString(signed?.url || signed?.signedUrl, 2000);
  const signedUrlExpiresAt = iso(signed?.expiresAt) || new Date(new Date(now).getTime() + ttl * 1000).toISOString();
  if (!/^https:\/\//i.test(signedUrl) || Date.parse(signedUrlExpiresAt) - new Date(now).getTime() < META_ORGANIC_EXPORT_URL_MIN_TTL_SECONDS * 1000) {
    throw Object.assign(new Error('Provider-readable export URL is not sufficiently bounded.'), { code: 'EXPORT_SIGNED_URL_INVALID' });
  }
  const manifest = buildManifest({
    context,
    source,
    outputBytes,
    objectPath,
    signedUrl,
    signedUrlExpiresAt,
    rendererVersion: META_ORGANIC_ARTWORK_RENDERER_VERSION,
    now,
  });
  await store.persistExportManifest(manifest);
  return { status: 'exported', manifest, bytes: outputBytes };
}

export function createInMemoryMetaOrganicArtworkExportStore(contexts = []) {
  const byRequest = new Map();
  const manifests = new Map();
  for (const context of contexts) {
    const request = buildMetaOrganicArtworkExportRequest(context.request || {
      userId: context.userId || context.post?.userId || context.post?.user_id,
      podId: context.podId || context.post?.podId || context.post?.pod_id,
      postId: context.postId || context.post?.id,
      provider: context.provider || context.post?.platform,
      accountConnectionId: context.accountConnectionId || context.account?.accountConnectionId || context.account?.account_connection_id,
      providerAccountId: context.providerAccountId || context.account?.providerAccountId || context.account?.provider_account_id,
      creativeApprovalId: context.creativeApprovalId || context.approvalId || context.approvalRow?.id,
    });
    byRequest.set(canonicalJson(request), context);
  }
  return {
    manifests,
    async loadApprovedArtworkContext(request) {
      const normalized = buildMetaOrganicArtworkExportRequest(request);
      const exact = byRequest.get(canonicalJson(normalized));
      if (exact) return structuredClone(exact);
      if (!normalized.accountConnectionId) {
        for (const [key, value] of byRequest.entries()) {
          const candidate = JSON.parse(key);
          if (candidate.userId === normalized.userId && candidate.podId === normalized.podId && candidate.postId === normalized.postId
            && candidate.provider === normalized.provider && candidate.providerAccountId === normalized.providerAccountId
            && candidate.creativeApprovalId === normalized.creativeApprovalId) return structuredClone(value);
        }
      }
      return null;
    },
    async persistExportManifest(manifest) {
      const validation = validateMetaOrganicArtworkManifest(manifest, new Date(manifest.createdAt || Date.now()));
      if (!validation.ok) throw Object.assign(new Error(validation.reason), { code: validation.reason });
      const request = buildMetaOrganicArtworkExportRequest({
        userId: manifest.authority.userId,
        podId: manifest.authority.podId,
        postId: manifest.authority.postId,
        provider: manifest.authority.provider,
        accountConnectionId: manifest.authority.accountConnectionId,
        providerAccountId: manifest.authority.providerAccountId,
        creativeApprovalId: manifest.authority.creativeApprovalId,
      });
      const latest = normalizeApprovedContext(structuredClone(byRequest.get(canonicalJson(request)) || null), request);
      if (!latest.ok) throw Object.assign(new Error(latest.reason), { code: latest.reason });
      const context = latest.normalized;
      const source = context.approval.sourceEvidence;
      const approvedOutput = context.approval.finalRenderEvidence;
      const expectedAuthority = {
        userId: context.post.userId, podId: context.post.podId, postId: context.post.id,
        provider: context.post.provider, accountConnectionId: context.request.accountConnectionId,
        providerAccountId: context.request.providerAccountId, creativeApprovalId: context.approval.id,
        approvedAt: context.approval.approvedAt, contentVersion: context.post.contentVersion,
        contentHash: context.post.contentHash, sourceIdentity: source.identity,
        sourceHash: source.hash, sourceKind: source.kind, rendererVersion: approvedOutput.rendererVersion,
      };
      const expectedComposition = { ...context.approval.composition, captionSnapshot: context.post.caption, brandName: context.pod.brandName };
      const actualOutput = { hash: manifest.output.hash, mediaType: manifest.output.mediaType,
        dimensions: manifest.output.dimensions, byteLength: manifest.output.byteLength,
        rendererVersion: manifest.authority.rendererVersion };
      if (canonicalJson(expectedAuthority) !== canonicalJson(manifest.authority)
        || canonicalJson(expectedComposition) !== canonicalJson(manifest.composition)
        || canonicalJson(manifestHashPayload({ source }).source) !== canonicalJson(manifestHashPayload(manifest).source)
        || canonicalJson(approvedOutput) !== canonicalJson(actualOutput)) {
        throw Object.assign(new Error('EXPORT_CONTEXT_CHANGED'), { code: 'EXPORT_CONTEXT_CHANGED' });
      }
      if (manifests.has(manifest.manifestHash)) throw Object.assign(new Error('Immutable export manifest already exists.'), { code: 'EXPORT_MANIFEST_IMMUTABLE' });
      manifests.set(manifest.manifestHash, structuredClone(manifest));
      return manifest;
    },
  };
}

export function createRpcMetaOrganicArtworkExportStore({ rpc = rpcWithServiceRole } = {}) {
  return {
    async loadApprovedArtworkContext(request) {
      return rpc('get_meta_organic_artwork_export_context', { p_request: buildMetaOrganicArtworkExportRequest(request) });
    },
    async persistExportManifest(manifest) {
      const validation = validateMetaOrganicArtworkManifest(manifest, new Date(manifest.createdAt || Date.now()));
      if (!validation.ok) throw Object.assign(new Error(validation.reason), { code: validation.reason });
      return rpc('persist_meta_organic_artwork_export_manifest', { p_manifest: manifest });
    },
  };
}
