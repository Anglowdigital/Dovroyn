import crypto from 'node:crypto';
import { getPlan, hasActivePaidAccess } from '../../src/lib/plans.js';
import { rpcWithServiceRole } from './supabaseAuth.js';
import { computeMetaOrganicArtworkManifestHash, META_ORGANIC_ARTWORK_RENDERER_VERSION } from './metaOrganicArtworkExport.js';

export const META_ORGANIC_PUBLISHER_CONTRACT_VERSION = 'meta_organic_publisher_pilot_v1';
export const META_ORGANIC_PUBLISHER_PROVENANCE = 'meta_organic_publisher_foundation_2026_10_12';
export const META_ORGANIC_PUBLISHER_DISABLED_REASON = 'publisher_disabled';
export const META_ORGANIC_MAX_ATTEMPTS = 3;
export const META_ORGANIC_LEASE_MS = 5 * 60 * 1000;

export const META_ORGANIC_PUBLISH_PERMISSIONS = Object.freeze({
  facebook: Object.freeze(['pages_manage_posts', 'pages_read_engagement']),
  instagram: Object.freeze(['instagram_basic', 'instagram_content_publish', 'pages_read_engagement']),
});

export const META_ORGANIC_TOKEN_KINDS = Object.freeze({
  facebook: 'page',
  instagram: 'page',
});

const FINAL_STATES = new Set(['published', 'failed', 'blocked', 'unknown']);
const CLAIMABLE_STATES = new Set(['queued', 'retry']);
const PROVIDERS = new Set(['facebook', 'instagram']);
const SAFE_RETRY_CODES = new Set([
  'REQUEST_TIMEOUT_BEFORE_WRITE',
  'PROVIDER_429_BEFORE_WRITE',
  'PROVIDER_TEMPORARY_BEFORE_WRITE',
]);
const AMBIGUOUS_AFTER_DISPATCH_CODES = new Set([
  'CONNECTION_RESET',
  'ECONNRESET',
  'ETIMEDOUT',
  'REQUEST_TIMEOUT',
  'PROVIDER_5XX',
  'PROVIDER_TIMEOUT',
  'PUBLISH_PERSISTENCE_FAILED_AFTER_PROVIDER_SUCCESS',
]);

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function iso(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function operationToken() {
  return crypto.randomBytes(24).toString('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireUuidLike(value, field) {
  const id = cleanString(value, 120);
  if (!id) throw new Error(`${field} is required.`);
  return id;
}

function normalizeProvider(provider) {
  const value = cleanString(provider, 40).toLowerCase();
  return PROVIDERS.has(value) ? value : '';
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function providerAccountId(value) {
  const id = cleanString(value, 80);
  return /^[1-9][0-9]{0,31}$/.test(id) ? id : '';
}

function futureIso(value, now, minMs = 0) {
  const parsed = iso(value);
  return parsed && new Date(parsed).getTime() > now.getTime() + minMs ? parsed : null;
}

export function getMetaOrganicPublisherConfig(env = process.env) {
  return {
    enabled: env.META_ORGANIC_PUBLISHER_ENABLED === 'true',
    contractVersion: META_ORGANIC_PUBLISHER_CONTRACT_VERSION,
    provenance: META_ORGANIC_PUBLISHER_PROVENANCE,
    maxAttempts: Number.isInteger(Number(env.META_ORGANIC_PUBLISHER_MAX_ATTEMPTS))
      ? Math.max(1, Math.min(5, Number(env.META_ORGANIC_PUBLISHER_MAX_ATTEMPTS)))
      : META_ORGANIC_MAX_ATTEMPTS,
    leaseMs: Number.isInteger(Number(env.META_ORGANIC_PUBLISHER_LEASE_MS))
      ? Math.max(30_000, Math.min(900_000, Number(env.META_ORGANIC_PUBLISHER_LEASE_MS)))
      : META_ORGANIC_LEASE_MS,
  };
}

export function makeMetaOrganicDedupeKey({ draftId, accountConnectionId, contentVersion, assetManifestHash, campaignDate }) {
  return sha256Hex(canonicalJson({
    draftId: requireUuidLike(draftId, 'draftId'),
    accountConnectionId: requireUuidLike(accountConnectionId, 'accountConnectionId'),
    contentVersion: requireUuidLike(contentVersion, 'contentVersion'),
    assetManifestHash: requireUuidLike(assetManifestHash, 'assetManifestHash'),
    campaignDate: dateOnly(campaignDate) || requireUuidLike(campaignDate, 'campaignDate'),
  }));
}

export function buildMetaOrganicPublishProposal(input = {}) {
  const provider = normalizeProvider(input.provider);
  if (!provider) throw new Error('A supported Meta organic provider is required.');
  const userId = requireUuidLike(input.userId, 'userId');
  const podId = requireUuidLike(input.podId, 'podId');
  const draftId = requireUuidLike(input.draftId, 'draftId');
  const accountConnectionId = requireUuidLike(input.accountConnectionId, 'accountConnectionId');
  const contentVersion = requireUuidLike(input.contentVersion, 'contentVersion');
  const assetManifestHash = requireUuidLike(input.assetManifestHash, 'assetManifestHash');
  const approvalId = requireUuidLike(input.approvalId, 'approvalId');
  const campaignDate = dateOnly(input.campaignDate);
  if (!campaignDate) throw new Error('A YYYY-MM-DD campaign date is required.');
  const scheduledAt = input.scheduledAt == null ? null : iso(input.scheduledAt);
  if (input.scheduledAt != null && !scheduledAt) throw new Error('A valid scheduledAt timestamp is required.');
  return {
    provider,
    userId,
    podId,
    draftId,
    accountConnectionId,
    contentVersion,
    assetManifestHash,
    approvalId,
    campaignDate,
    scheduledAt,
    dedupeKey: makeMetaOrganicDedupeKey({ draftId, accountConnectionId, contentVersion, assetManifestHash, campaignDate }),
    contractVersion: META_ORGANIC_PUBLISHER_CONTRACT_VERSION,
  };
}

export class SafeRetryablePublishError extends Error {
  constructor(message = 'Meta organic provider request can be retried safely.', code = 'REQUEST_TIMEOUT_BEFORE_WRITE') {
    super(message);
    this.name = 'SafeRetryablePublishError';
    this.code = SAFE_RETRY_CODES.has(code) ? code : 'REQUEST_TIMEOUT_BEFORE_WRITE';
    this.retryable = true;
  }
}

export class UnknownOutcomePublishError extends Error {
  constructor(message = 'Meta organic provider outcome is unknown.', receipt = {}) {
    super(message);
    this.name = 'UnknownOutcomePublishError';
    this.code = 'OUTCOME_UNKNOWN';
    this.receipt = receipt;
    this.unknownOutcome = true;
  }
}

export function validateMetaOrganicPublishContext(context = {}, now = new Date()) {
  const proposal = buildMetaOrganicPublishProposal(context.proposal || context);
  const draft = context.draft || {};
  const approval = context.approval || {};
  const asset = context.asset || {};
  const account = context.account || {};
  const subscription = context.subscription || null;
  const existingCampaignDates = list(context.existingCampaignDates);

  if (!hasActivePaidAccess(subscription, now)) return { ok: false, reason: 'PUBLISH_PAID_PLAN_REQUIRED' };
  const plan = getPlan(subscription.tier);
  if (!plan.monthlyContentDays) return { ok: false, reason: 'PUBLISH_PAID_PLAN_REQUIRED' };
  if (draft.userId !== proposal.userId || draft.podId !== proposal.podId) return { ok: false, reason: 'PUBLISH_TENANT_MISMATCH' };
  if (draft.id !== proposal.draftId || draft.provider !== proposal.provider) return { ok: false, reason: 'PUBLISH_DRAFT_MISMATCH' };
  if (!['approved', 'ready'].includes(draft.status)) return { ok: false, reason: 'PUBLISH_DRAFT_NOT_APPROVED' };
  if (draft.contentVersion !== proposal.contentVersion) return { ok: false, reason: 'PUBLISH_CONTENT_CHANGED' };
  const captionLimit = proposal.provider === 'instagram' ? 2200 : 63206;
  if (typeof draft.caption !== 'string' || draft.caption.length === 0) return { ok: false, reason: 'PUBLISH_CAPTION_REQUIRED' };
  if (draft.caption.length > captionLimit) return { ok: false, reason: 'PUBLISH_CAPTION_TOO_LONG' };

  if (approval.id !== proposal.approvalId || approval.userId !== proposal.userId || approval.podId !== proposal.podId
    || approval.draftId !== proposal.draftId || approval.accountConnectionId !== proposal.accountConnectionId
    || approval.contentVersion !== proposal.contentVersion || approval.assetManifestHash !== proposal.assetManifestHash
    || approval.campaignDate !== proposal.campaignDate || approval.status !== 'approved' || !iso(approval.approvedAt)) {
    return { ok: false, reason: 'PUBLISH_APPROVAL_CHANGED' };
  }

  const outputHash = cleanString(asset.outputHash || asset.output_hash, 80);
  const manifestOutputHash = cleanString(asset.manifest?.output?.hash, 80);
  const manifestAuthority = asset.manifest?.authority || {};
  const manifestOutput = asset.manifest?.output || {};
  const recomputedManifestHash = asset.manifest ? computeMetaOrganicArtworkManifestHash(asset.manifest) : '';
  const expiresAt = futureIso(asset.providerReadableUrlExpiresAt || asset.provider_readable_url_expires_at || manifestOutput.providerReadableUrlExpiresAt, now, 10 * 60 * 1000);
  if (asset.userId !== proposal.userId || asset.podId !== proposal.podId || asset.draftId !== proposal.draftId
    || asset.accountConnectionId !== proposal.accountConnectionId || asset.manifestHash !== proposal.assetManifestHash
    || recomputedManifestHash !== proposal.assetManifestHash
    || asset.status !== 'exported' || asset.immutable !== true || !isHttpsUrl(asset.providerReadableUrl)
    || asset.mediaType !== 'image/jpeg' || !/^[a-f0-9]{64}$/.test(outputHash) || !expiresAt
    || manifestAuthority.userId !== proposal.userId || manifestAuthority.podId !== proposal.podId || manifestAuthority.postId !== proposal.draftId
    || manifestAuthority.accountConnectionId !== proposal.accountConnectionId || !cleanString(manifestAuthority.creativeApprovalId, 120)
    || manifestAuthority.provider !== proposal.provider || manifestAuthority.providerAccountId !== account.providerAccountId
    || manifestAuthority.rendererVersion !== META_ORGANIC_ARTWORK_RENDERER_VERSION
    || manifestAuthority.contentVersion !== proposal.contentVersion || manifestOutputHash !== outputHash
    || manifestOutput.mediaType !== 'image/jpeg' || manifestOutput.providerReadableUrl !== asset.providerReadableUrl
    || manifestOutput.objectPath !== asset.objectVersion) {
    return { ok: false, reason: 'PUBLISH_ASSET_EXPORT_REQUIRED' };
  }

  if (account.id !== proposal.accountConnectionId || account.userId !== proposal.userId || account.podId !== proposal.podId
    || account.provider !== proposal.provider || account.status !== 'connected') {
    return { ok: false, reason: 'PUBLISH_CONNECTION_REQUIRED' };
  }
  const accountExpiresAt = iso(account.expiresAt);
  if (!accountExpiresAt || new Date(accountExpiresAt) <= new Date(now.getTime() + 60_000)) {
    return { ok: false, reason: 'PUBLISH_CONNECTION_EXPIRED' };
  }
  const safeProviderAccountId = providerAccountId(account.providerAccountId);
  if (!safeProviderAccountId) return { ok: false, reason: 'PUBLISH_ACCOUNT_CONTEXT_REQUIRED' };
  if (account.tokenKind !== META_ORGANIC_TOKEN_KINDS[proposal.provider]) {
    return { ok: false, reason: 'PUBLISH_TOKEN_CONTRACT_REQUIRED' };
  }
  const granted = new Set(list(account.grantedScopes));
  const missing = META_ORGANIC_PUBLISH_PERMISSIONS[proposal.provider].filter((scope) => !granted.has(scope));
  if (missing.length) return { ok: false, reason: 'PUBLISH_PERMISSION_REQUIRED', missingScopes: missing };

  const distinctDates = new Set(existingCampaignDates.map(dateOnly).filter(Boolean));
  const campaignDateAlreadyUsed = distinctDates.has(proposal.campaignDate);
  distinctDates.add(proposal.campaignDate);
  if (distinctDates.size > plan.monthlyContentDays) return { ok: false, reason: 'PUBLISH_DISTINCT_DAY_LIMIT' };
  if (plan.weeklyPostingDays && !campaignDateAlreadyUsed) {
    const weekStart = utcWeekStart(proposal.campaignDate);
    const weekDates = new Set([...distinctDates].filter((date) => utcWeekStart(date) === weekStart));
    if (weekDates.size > plan.weeklyPostingDays) return { ok: false, reason: 'PUBLISH_WEEKLY_DISTINCT_DAY_LIMIT' };
  }

  return {
    ok: true,
    proposal,
    providerPayload: {
      caption: draft.caption,
      accountId: safeProviderAccountId,
      assetUrl: asset.providerReadableUrl,
      assetManifestHash: asset.manifestHash,
      campaignDate: proposal.campaignDate,
    },
  };
}

function utcWeekStart(date) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return '';
  const day = parsed.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  parsed.setUTCDate(parsed.getUTCDate() + mondayOffset);
  return parsed.toISOString().slice(0, 10);
}

function jobField(job, camel, snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)) {
  return job?.[camel] ?? job?.[snake];
}

function assertContextMatchesClaimedJob(job, context) {
  const proposal = buildMetaOrganicPublishProposal(context.proposal || context);
  const fields = ['dedupeKey', 'userId', 'podId', 'draftId', 'provider', 'accountConnectionId', 'contentVersion', 'assetManifestHash', 'approvalId', 'campaignDate'];
  const mismatched = fields.find((field) => String(jobField(job, field) || '') !== String(proposal[field] || ''));
  if (mismatched) {
    return { ok: false, reason: 'PUBLISH_CONTEXT_MISMATCH', field: mismatched };
  }
  return { ok: true };
}

function isAmbiguousAfterDispatch(error) {
  const code = cleanString(error?.code || error?.cause?.code, 80).toUpperCase();
  if (AMBIGUOUS_AFTER_DISPATCH_CODES.has(code)) return true;
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  return status >= 500 && status <= 599;
}

function sanitizeProviderReceipt(receipt, validation) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new UnknownOutcomePublishError('Provider acknowledgement did not include a receipt.', {
      provider: validation.proposal.provider,
      providerAccountId: validation.providerPayload.accountId,
      reason: 'MISSING_PROVIDER_RECEIPT',
    });
  }
  const provider = cleanString(receipt.provider || validation.proposal.provider, 40).toLowerCase();
  const accountId = providerAccountId(receipt.providerAccountId || validation.providerPayload.accountId);
  const providerPostId = cleanString(receipt.providerPostId || receipt.mediaId || receipt.postId, 120);
  if (provider !== validation.proposal.provider || accountId !== validation.providerPayload.accountId || !providerPostId) {
    throw new UnknownOutcomePublishError('Provider acknowledgement was ambiguous.', {
      provider: validation.proposal.provider,
      providerAccountId: validation.providerPayload.accountId,
      reason: 'AMBIGUOUS_PROVIDER_RECEIPT',
    });
  }
  const permalink = isHttpsUrl(receipt.permalink) ? receipt.permalink : null;
  const safe = {
    provider: validation.proposal.provider,
    providerAccountId: validation.providerPayload.accountId,
    status: 'published',
    providerPostId,
  };
  if (permalink) safe.permalink = permalink;
  if (cleanString(receipt.containerId, 120)) safe.containerId = cleanString(receipt.containerId, 120);
  return safe;
}

function sanitizeUnknownReceipt(receipt, fallback = {}) {
  const input = receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : {};
  const provider = normalizeProvider(input.provider || fallback.provider) || fallback.provider;
  const accountId = providerAccountId(input.providerAccountId || fallback.providerAccountId);
  const safe = {};
  if (provider) safe.provider = provider;
  if (accountId) safe.providerAccountId = accountId;
  const reason = cleanString(input.reason || fallback.reason || input.code, 120);
  if (reason) safe.reason = reason;
  const operation = cleanString(input.operation || fallback.operation, 120);
  if (operation) safe.operation = operation;
  const providerPostId = cleanString(input.providerPostId || input.mediaId || input.postId, 120);
  if (providerPostId) safe.providerPostId = providerPostId;
  const dedupeKey = /^[a-f0-9]{64}$/.test(String(input.dedupeKey || '')) ? input.dedupeKey : '';
  if (dedupeKey) safe.dedupeKey = dedupeKey;
  if (isHttpsUrl(input.permalink)) safe.permalink = input.permalink;
  return safe;
}

function sanitizeReconciliationReceipt(receipt, job) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { ok: false, reason: 'RECONCILE_INCONCLUSIVE' };
  if (receipt.status && !['found', 'published', 'reconciled'].includes(receipt.status)) return { ok: false, reason: 'RECONCILE_INCONCLUSIVE' };
  const provider = cleanString(receipt.provider || job.provider, 40).toLowerCase();
  const accountId = providerAccountId(receipt.providerAccountId);
  const providerPostId = cleanString(receipt.providerPostId || receipt.mediaId || receipt.postId, 120);
  const priorReceipt = job.receipts?.[job.accountConnectionId] || job.receipts?.[job.account_connection_id] || {};
  const expectedAccountId = providerAccountId(job.providerAccountId || job.provider_account_id || priorReceipt.providerAccountId);
  if (provider !== job.provider || !expectedAccountId || accountId !== expectedAccountId || !providerPostId) {
    return { ok: false, reason: 'RECONCILE_PROOF_MISMATCH' };
  }
  const deliveryMatches = receipt.dedupeKey === job.dedupeKey
    || (
      receipt.draftId === job.draftId
      && receipt.accountConnectionId === job.accountConnectionId
      && receipt.contentVersion === job.contentVersion
      && receipt.assetManifestHash === job.assetManifestHash
      && dateOnly(receipt.campaignDate) === job.campaignDate
    );
  if (!deliveryMatches) return { ok: false, reason: 'RECONCILE_PROOF_MISMATCH' };
  const safe = {
    provider: job.provider,
    providerAccountId: accountId,
    providerPostId,
    status: 'reconciled',
    reconciledAt: new Date().toISOString(),
  };
  if (isHttpsUrl(receipt.permalink)) safe.permalink = receipt.permalink;
  return { ok: true, receipt: safe };
}

export function createRpcMetaOrganicPublishStore({ rpc = rpcWithServiceRole } = {}) {
  return {
    async enqueue(proposal) {
      return rpc('enqueue_meta_organic_publish_job', { p_proposal: proposal });
    },
    async claimNext({ workerId, now, leaseMs }) {
      return rpc('claim_meta_organic_publish_job', {
        p_worker_id: workerId,
        p_now: now.toISOString(),
        p_lease_ms: leaseMs,
      });
    },
    async loadContext(job) {
      return rpc('get_meta_organic_publish_context', {
        p_job_id: job.id,
        p_worker_id: job.leasedBy || job.leased_by,
        p_operation_token: job.operationToken || job.operation_token,
      });
    },
    async markBlocked(job, reason, details) {
      return rpc('mark_meta_organic_publish_blocked', { p_job_id: job.id, p_worker_id: job.leasedBy || job.leased_by, p_operation_token: job.operationToken || job.operation_token, p_reason: reason, p_details: details || {} });
    },
    async markRetry(job, reason, details, retryAt) {
      return rpc('mark_meta_organic_publish_retry', { p_job_id: job.id, p_worker_id: job.leasedBy || job.leased_by, p_operation_token: job.operationToken || job.operation_token, p_reason: reason, p_details: details || {}, p_retry_at: retryAt.toISOString() });
    },
    async markFailed(job, reason, details) {
      return rpc('mark_meta_organic_publish_failed', { p_job_id: job.id, p_worker_id: job.leasedBy || job.leased_by, p_operation_token: job.operationToken || job.operation_token, p_reason: reason, p_details: details || {} });
    },
    async markUnknown(job, reason, receipt) {
      return rpc('mark_meta_organic_publish_unknown', { p_job_id: job.id, p_worker_id: job.leasedBy || job.leased_by, p_operation_token: job.operationToken || job.operation_token, p_reason: reason, p_receipt: receipt || {} });
    },
    async markPublished(job, receipt) {
      return rpc('mark_meta_organic_publish_published', { p_job_id: job.id, p_worker_id: job.leasedBy || job.leased_by, p_operation_token: job.operationToken || job.operation_token, p_receipt: receipt || {} });
    },
    async claimUnknownForReconciliation({ workerId, now, leaseMs }) {
      return rpc('claim_meta_organic_reconciliation_job', {
        p_worker_id: workerId,
        p_now: now.toISOString(),
        p_lease_ms: leaseMs,
      });
    },
    async markReconciled(job, receipt) {
      return rpc('mark_meta_organic_publish_reconciled', { p_job_id: job.id, p_worker_id: job.leasedBy || job.leased_by, p_operation_token: job.operationToken || job.operation_token, p_receipt: receipt || {} });
    },
    async keepUnknown(job, reason, receipt) {
      return rpc('mark_meta_organic_reconciliation_inconclusive', { p_job_id: job.id, p_worker_id: job.leasedBy || job.leased_by, p_operation_token: job.operationToken || job.operation_token, p_reason: reason, p_receipt: receipt || {} });
    },
  };
}

export function createInMemoryMetaOrganicPublishStore(contexts = []) {
  return createInMemoryMetaOrganicPublishStoreWithClock(contexts, null);
}

export function createInMemoryMetaOrganicPublishStoreWithClock(contexts = [], clock = null) {
  const jobs = [];
  const contextByDedupe = new Map();
  for (const context of contexts) {
    const proposal = buildMetaOrganicPublishProposal(context.proposal || context);
    contextByDedupe.set(proposal.dedupeKey, { ...context, proposal });
  }
  return {
    jobs,
    contextByDedupe,
    async enqueue(input) {
      const proposal = buildMetaOrganicPublishProposal(input);
      const existing = jobs.find((job) => job.dedupeKey === proposal.dedupeKey);
      if (existing) return { ...existing, duplicate: true };
      const job = {
        id: `job-${jobs.length + 1}`,
        ...proposal,
        state: 'queued',
        attempts: 0,
        receipts: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        scheduledAt: proposal.scheduledAt,
        leasedBy: null,
        leaseExpiresAt: null,
        operationToken: null,
      };
      jobs.push(job);
      if (!contextByDedupe.has(proposal.dedupeKey)) contextByDedupe.set(proposal.dedupeKey, { proposal });
      return { ...job, duplicate: false };
    },
    async claimNext({ workerId, now, leaseMs }) {
      const nowMs = now.getTime();
      const expiredLease = jobs.find((candidate) => candidate.state === 'leased'
        && candidate.leaseExpiresAt
        && Date.parse(candidate.leaseExpiresAt) <= nowMs);
      if (expiredLease) {
        const context = contextByDedupe.get(expiredLease.dedupeKey);
        expiredLease.state = 'unknown';
        expiredLease.errorCode = 'PUBLISH_LEASE_EXPIRED_RECONCILE_REQUIRED';
        expiredLease.receipts = {
          [expiredLease.accountConnectionId]: sanitizeUnknownReceipt({}, {
            provider: expiredLease.provider,
            providerAccountId: context?.account?.providerAccountId,
            reason: 'PUBLISH_LEASE_EXPIRED_RECONCILE_REQUIRED',
          }),
        };
        expiredLease.leasedBy = null;
        expiredLease.operationToken = null;
        expiredLease.leaseExpiresAt = null;
        expiredLease.updatedAt = now.toISOString();
        return null;
      }
      const job = jobs.find((candidate) => {
        return CLAIMABLE_STATES.has(candidate.state)
          && (!candidate.retryAt || Date.parse(candidate.retryAt) <= nowMs)
          && (!candidate.scheduledAt || Date.parse(candidate.scheduledAt) <= nowMs)
          && (!candidate.leaseExpiresAt || Date.parse(candidate.leaseExpiresAt) <= nowMs);
      });
      if (!job) return null;
      job.state = 'leased';
      job.leasedBy = workerId;
      job.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      job.operationToken = operationToken();
      job.claimedAt = now.toISOString();
      job.updatedAt = now.toISOString();
      return { ...job };
    },
    async loadContext(job) {
      const current = jobs.find((candidate) => candidate.id === job.id);
      if (!current || FINAL_STATES.has(current.state)) return null;
      const context = contextByDedupe.get(current.dedupeKey);
      return context ? structuredClone(context) : null;
    },
    async markBlocked(job, reason, details = {}) {
      return update(job, { state: 'blocked', errorCode: reason, details }, { requireUnexpired: true });
    },
    async markRetry(job, reason, details = {}, retryAt) {
      return update(job, { state: 'retry', attempts: job.attempts, errorCode: reason, details, retryAt: retryAt.toISOString(), leaseExpiresAt: null }, { requireUnexpired: true });
    },
    async markFailed(job, reason, details = {}) {
      return update(job, { state: 'failed', attempts: job.attempts, errorCode: reason, details }, { requireUnexpired: true });
    },
    async markUnknown(job, reason, receipt = {}) {
      return update(job, { state: 'unknown', errorCode: reason, receipts: { [job.accountConnectionId]: sanitizeUnknownReceipt(receipt, { provider: job.provider, reason }) } }, { allowExpired: true });
    },
    async markPublished(job, receipt = {}) {
      return update(job, { state: 'published', errorCode: null, receipts: { [job.accountConnectionId]: receipt } }, { requireUnexpired: true });
    },
    async claimUnknownForReconciliation({ workerId, now, leaseMs }) {
      const nowMs = now.getTime();
      const job = jobs.find((candidate) => {
        const leaseExpired = candidate.state === 'reconciling' && candidate.leaseExpiresAt && Date.parse(candidate.leaseExpiresAt) <= nowMs;
        return (candidate.state === 'unknown' || leaseExpired)
          && (!candidate.leaseExpiresAt || Date.parse(candidate.leaseExpiresAt) <= nowMs);
      });
      if (!job) return null;
      job.state = 'reconciling';
      job.leasedBy = workerId;
      job.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      job.operationToken = operationToken();
      job.claimedAt = now.toISOString();
      job.updatedAt = now.toISOString();
      return { ...job };
    },
    async markReconciled(job, receipt = {}) {
      return update(job, { state: 'published', errorCode: null, receipts: { [job.accountConnectionId]: receipt } }, { requireUnexpired: true, allowedState: 'reconciling' });
    },
    async keepUnknown(job, reason, receipt = {}) {
      return update(job, { state: 'unknown', errorCode: reason, receipts: { [job.accountConnectionId]: sanitizeUnknownReceipt(receipt, { provider: job.provider, reason }) } }, { allowExpired: true, allowedState: 'reconciling' });
    },
  };

  function update(claim, patch, options = {}) {
    const job = jobs.find((candidate) => candidate.id === claim.id);
    if (!job) return null;
    const sameClaim = job.state === (options.allowedState || 'leased')
      && job.leasedBy === claim.leasedBy
      && job.operationToken
      && job.operationToken === claim.operationToken;
    if (!sameClaim) throw Object.assign(new Error('PUBLISH_CLAIM_REQUIRED'), { code: 'PUBLISH_CLAIM_REQUIRED' });
    const currentTime = typeof clock === 'function' ? Number(clock()) : Number.NaN;
    const expiredAgainstClock = job.leaseExpiresAt && Number.isFinite(currentTime) && Date.parse(job.leaseExpiresAt) <= currentTime;
    if (options.requireUnexpired && expiredAgainstClock) {
      throw Object.assign(new Error('PUBLISH_LEASE_EXPIRED'), { code: 'PUBLISH_LEASE_EXPIRED' });
    }
    if (!options.allowExpired && expiredAgainstClock) {
      throw Object.assign(new Error('PUBLISH_LEASE_EXPIRED'), { code: 'PUBLISH_LEASE_EXPIRED' });
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString(), leasedBy: null, operationToken: null, leaseExpiresAt: null });
    return { ...job };
  }
}

export async function reconcileNextMetaOrganicPublishJob({
  config = getMetaOrganicPublisherConfig(),
  store = createRpcMetaOrganicPublishStore(),
  provider,
  workerId = `reconciler-${process.pid}`,
  now = new Date(),
} = {}) {
  if (!config.enabled) {
    return { status: 'disabled', reason: META_ORGANIC_PUBLISHER_DISABLED_REASON };
  }
  if (!provider || typeof provider.lookupPublishedMetaOrganicReceipt !== 'function') {
    throw new Error('A read-only Meta organic reconciliation adapter is required.');
  }
  const job = await store.claimUnknownForReconciliation({ workerId, now, leaseMs: config.leaseMs });
  if (!job) return { status: 'idle' };
  let proof;
  try {
    proof = await provider.lookupPublishedMetaOrganicReceipt({
      provider: job.provider,
      accountConnectionId: job.accountConnectionId,
      accountConnectionIdSnake: job.account_connection_id,
      dedupeKey: job.dedupeKey,
      draftId: job.draftId,
      contentVersion: job.contentVersion,
      assetManifestHash: job.assetManifestHash,
      campaignDate: job.campaignDate,
    });
  } catch (error) {
    await store.keepUnknown(job, 'RECONCILE_LOOKUP_ERROR', sanitizeUnknownReceipt({}, {
      provider: job.provider,
      providerAccountId: job.providerAccountId || job.provider_account_id || job.receipts?.[job.accountConnectionId]?.providerAccountId || job.receipts?.[job.account_connection_id]?.providerAccountId,
      reason: cleanString(error?.code || error?.message || 'RECONCILE_LOOKUP_ERROR', 120),
    }));
    return { status: 'unknown', jobId: job.id, reason: 'RECONCILE_LOOKUP_ERROR' };
  }
  const reconciliation = sanitizeReconciliationReceipt(proof, job);
  if (!reconciliation.ok) {
    await store.keepUnknown(job, reconciliation.reason, sanitizeUnknownReceipt(proof, {
      provider: job.provider,
      providerAccountId: job.providerAccountId || job.provider_account_id || job.receipts?.[job.accountConnectionId]?.providerAccountId || job.receipts?.[job.account_connection_id]?.providerAccountId,
      reason: reconciliation.reason,
    }));
    return { status: 'unknown', jobId: job.id, reason: reconciliation.reason };
  }
  await store.markReconciled(job, reconciliation.receipt);
  return { status: 'reconciled', jobId: job.id };
}

function retryDelayMs(attempts) {
  return Math.min(15 * 60 * 1000, (2 ** Math.max(0, attempts - 1)) * 60 * 1000);
}

async function publishWithProvider(provider, validation) {
  if (validation.proposal.provider === 'facebook') {
    if (typeof provider.publishFacebookPagePhoto !== 'function') throw new Error('Facebook Page provider adapter is not configured.');
    return provider.publishFacebookPagePhoto(validation.providerPayload);
  }
  if (typeof provider.publishInstagramImage !== 'function') throw new Error('Instagram provider adapter is not configured.');
  return provider.publishInstagramImage(validation.providerPayload);
}

export async function processNextMetaOrganicPublishJob({
  config = getMetaOrganicPublisherConfig(),
  store = createRpcMetaOrganicPublishStore(),
  provider,
  workerId = `worker-${process.pid}`,
  now = new Date(),
} = {}) {
  if (!config.enabled) {
    return { status: 'disabled', reason: META_ORGANIC_PUBLISHER_DISABLED_REASON };
  }
  if (!provider) throw new Error('A Meta organic provider adapter is required.');
  const job = await store.claimNext({ workerId, now, leaseMs: config.leaseMs });
  if (!job) return { status: 'idle' };
  let context;
  try {
    context = await store.loadContext(job);
  } catch (error) {
    const reason = cleanString(error?.code || error?.message || 'PUBLISH_CONTEXT_UNAVAILABLE', 120);
    try {
      await store.markBlocked(job, reason, { reason });
    } catch {
      return { status: 'blocked', jobId: job.id, reason };
    }
    return { status: 'blocked', jobId: job.id, reason };
  }
  if (!context) {
    await store.markBlocked(job, 'PUBLISH_CONTEXT_UNAVAILABLE');
    return { status: 'blocked', jobId: job.id, reason: 'PUBLISH_CONTEXT_UNAVAILABLE' };
  }
  const contextMatch = assertContextMatchesClaimedJob(job, context);
  if (!contextMatch.ok) {
    await store.markBlocked(job, contextMatch.reason, contextMatch);
    return { status: 'blocked', jobId: job.id, reason: contextMatch.reason };
  }
  const validation = validateMetaOrganicPublishContext(context, now);
  if (!validation.ok) {
    await store.markBlocked(job, validation.reason, validation);
    return { status: 'blocked', jobId: job.id, reason: validation.reason };
  }
  let providerReceipt;
  try {
    providerReceipt = sanitizeProviderReceipt(await publishWithProvider(provider, validation), validation);
  } catch (error) {
    // Any unproven adapter failure may follow a completed provider write.
    const provenBeforeWrite = error instanceof SafeRetryablePublishError && SAFE_RETRY_CODES.has(error.code);
    if (error?.unknownOutcome || isAmbiguousAfterDispatch(error) || !provenBeforeWrite) {
      const receipt = sanitizeUnknownReceipt(error?.receipt || {
        provider: validation.proposal.provider,
        providerAccountId: validation.providerPayload.accountId,
        reason: error?.code || error?.cause?.code || 'OUTCOME_UNKNOWN',
      }, {
        provider: validation.proposal.provider,
        providerAccountId: validation.providerPayload.accountId,
        reason: error?.code || 'OUTCOME_UNKNOWN',
      });
      try {
        await store.markUnknown(job, error?.code || 'OUTCOME_UNKNOWN', receipt);
      } catch {
        return { status: 'unknown', jobId: job.id, reason: 'PUBLISH_UNKNOWN_OUTCOME_UNFENCED' };
      }
      return { status: 'unknown', jobId: job.id, reason: error?.code || 'OUTCOME_UNKNOWN' };
    }
    const attempts = Number(job.attempts || 0) + 1;
    if (error instanceof SafeRetryablePublishError && SAFE_RETRY_CODES.has(error.code) && attempts < config.maxAttempts) {
      job.attempts = attempts;
      const retryAt = new Date(now.getTime() + retryDelayMs(attempts));
      await store.markRetry(job, error.code || 'REQUEST_TIMEOUT_BEFORE_WRITE', { attempts }, retryAt);
      return { status: 'retry', jobId: job.id, reason: error.code || 'REQUEST_TIMEOUT_BEFORE_WRITE' };
    }
    await store.markFailed({ ...job, attempts }, error?.code || 'PROVIDER_REJECTED', { attempts });
    return { status: 'failed', jobId: job.id, reason: error?.code || 'PROVIDER_REJECTED' };
  }

  const publishedReceipt = {
    provider: validation.proposal.provider,
    providerAccountId: validation.providerPayload.accountId,
    status: 'published',
    publishedAt: new Date().toISOString(),
    ...providerReceipt,
  };
  try {
    await store.markPublished(job, {
      ...publishedReceipt,
    });
    return { status: 'published', jobId: job.id };
  } catch (error) {
    const unknownReceipt = {
      ...publishedReceipt,
      status: 'unknown',
      reason: 'PUBLISH_PERSISTENCE_FAILED_AFTER_PROVIDER_SUCCESS',
      persistenceError: cleanString(error?.code || error?.message || 'PUBLISH_PERSISTENCE_FAILED_AFTER_PROVIDER_SUCCESS', 120),
    };
    try {
      await store.markUnknown(job, 'PUBLISH_PERSISTENCE_FAILED_AFTER_PROVIDER_SUCCESS', sanitizeUnknownReceipt(unknownReceipt, {
        provider: validation.proposal.provider,
        providerAccountId: validation.providerPayload.accountId,
        reason: 'PUBLISH_PERSISTENCE_FAILED_AFTER_PROVIDER_SUCCESS',
      }));
    } catch {
      return { status: 'unknown', jobId: job.id, reason: 'PUBLISH_PERSISTENCE_UNFENCED_AFTER_PROVIDER_SUCCESS' };
    }
    return { status: 'unknown', jobId: job.id, reason: 'PUBLISH_PERSISTENCE_FAILED_AFTER_PROVIDER_SUCCESS' };
  }
}
