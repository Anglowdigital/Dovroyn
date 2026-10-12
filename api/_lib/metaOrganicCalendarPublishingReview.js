import crypto from 'node:crypto';
import { loadOwnedPod, rpcWithServiceRole, supabaseAuthedGet } from './supabaseAuth.js';
import { enqueueExplicitMetaOrganicPublishingApprovals } from './metaOrganicPublisher.js';

export const META_ORGANIC_CALENDAR_REVIEW_TOKEN_VERSION = 'meta_organic_calendar_publish_review_v1';
const REVIEW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_UTC_HOUR = 12;
const SUPPORTED_PROVIDERS = new Set(['facebook', 'instagram']);

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

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function tokenSecret(env = process.env) {
  const secret = env.META_CALENDAR_PUBLISH_REVIEW_TOKEN_SECRET
    || env.META_ARTWORK_REVIEW_TOKEN_SECRET
    || env.META_OAUTH_COOKIE_SECRET
    || env.META_TOKEN_ENCRYPTION_KEY
    || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw Object.assign(new Error('Calendar publishing review is not configured.'), { status: 503, code: 'PUBLISH_REVIEW_UNAVAILABLE' });
  return secret;
}

function signToken(payload, env) {
  const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
  return `${encoded}.${hmac(encoded, tokenSecret(env))}`;
}

export function verifyCalendarPublishingReviewToken(token, env = process.env, now = Date.now()) {
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra) throw Object.assign(new Error('Publishing review has expired. Prepare it again.'), { status: 409, code: 'PUBLISH_REVIEW_TOKEN_INVALID' });
  const expected = hmac(encoded, tokenSecret(env));
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw Object.assign(new Error('Publishing review was altered. Prepare it again.'), { status: 409, code: 'PUBLISH_REVIEW_TOKEN_INVALID' });
  }
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (payload.version !== META_ORGANIC_CALENDAR_REVIEW_TOKEN_VERSION || Date.parse(payload.expiresAt || '') <= now) {
    throw Object.assign(new Error('Publishing review has expired. Prepare it again.'), { status: 409, code: 'PUBLISH_REVIEW_TOKEN_EXPIRED' });
  }
  return payload;
}

function iso(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
}

function defaultScheduledAt(campaignDate) {
  return `${campaignDate}T${String(DEFAULT_UTC_HOUR).padStart(2, '0')}:00:00.000Z`;
}

function normalizeProvider(value) {
  const provider = cleanString(value, 40).toLowerCase();
  return SUPPORTED_PROVIDERS.has(provider) ? provider : '';
}

function numericId(value) {
  const id = cleanString(value, 80);
  return /^[1-9][0-9]{0,31}$/.test(id) ? id : '';
}

function requireHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeCalendarReviewEntry(raw = {}) {
  const provider = normalizeProvider(raw.provider || raw.platform);
  const accountConnectionId = cleanString(raw.accountConnectionId || raw.account_connection_id, 120);
  const providerAccountId = numericId(raw.providerAccountId || raw.provider_account_id);
  const accountLabel = cleanString(raw.accountLabel || raw.account_label, 200);
  const draftId = cleanString(raw.draftId || raw.draft_id || raw.postId || raw.post_id, 120);
  const calendarItemId = cleanString(raw.calendarItemId || raw.calendar_item_id, 120);
  const contentVersion = cleanString(raw.contentVersion || raw.content_version, 120);
  const assetManifestHash = cleanString(raw.assetManifestHash || raw.asset_manifest_hash || raw.manifestHash || raw.manifest_hash, 80);
  const calendarSnapshotHash = cleanString(raw.calendarSnapshotHash || raw.calendar_snapshot_hash, 80);
  const outputHash = cleanString(raw.outputHash || raw.output_hash, 80);
  const imageUrl = requireHttpsUrl(raw.imageUrl || raw.image_url || raw.providerReadableUrl || raw.provider_readable_url);
  const imageUrlExpiresAt = iso(raw.imageUrlExpiresAt || raw.image_url_expires_at || raw.providerReadableUrlExpiresAt || raw.provider_readable_url_expires_at);
  const caption = typeof raw.caption === 'string' ? raw.caption : '';
  if (!provider || !accountConnectionId || !providerAccountId || !accountLabel || !draftId || !calendarItemId
    || !contentVersion || !/^[a-f0-9]{64}$/.test(assetManifestHash) || !/^[a-f0-9]{64}$/.test(outputHash)
    || (calendarSnapshotHash && !/^[a-f0-9]{64}$/.test(calendarSnapshotHash))
    || !imageUrl || !imageUrlExpiresAt || !caption) {
    throw Object.assign(new Error('Calendar publishing review context is incomplete.'), { status: 409, code: 'PUBLISH_REVIEW_CONTEXT_REQUIRED' });
  }
  const reviewEntryId = sha256Hex(canonicalJson({ calendarItemId, accountConnectionId, assetManifestHash }));
  return {
    reviewEntryId,
    calendarItemId,
    calendarCreatedAt: iso(raw.calendarCreatedAt || raw.calendar_created_at) || null,
    calendarSnapshotHash,
    provider,
    draftId,
    caption,
    contentVersion,
    creativeApprovalId: cleanString(raw.creativeApprovalId || raw.creative_approval_id, 120),
    creativeApprovedAt: iso(raw.creativeApprovedAt || raw.creative_approved_at) || null,
    accountConnectionId,
    providerAccountId,
    accountLabel,
    assetManifestHash,
    outputHash,
    imageUrl,
    imageUrlExpiresAt,
  };
}

function normalizeCalendarReviewContext(raw = {}, { userId, podId, scheduledDate, now = Date.now() } = {}) {
  const trustedUserId = cleanString(raw.userId || raw.user_id || userId, 120);
  const trustedPodId = cleanString(raw.podId || raw.pod_id || podId, 120);
  const campaignDate = dateOnly(raw.scheduledDate || raw.scheduled_date || raw.campaignDate || raw.campaign_date || scheduledDate);
  const timezone = cleanString(raw.timezone || raw.time_zone || 'UTC', 80) || 'UTC';
  const scheduledAt = iso(raw.scheduledAt || raw.scheduled_at || defaultScheduledAt(campaignDate));
  if (!trustedUserId || trustedUserId !== userId || !trustedPodId || trustedPodId !== podId || !campaignDate || !scheduledAt) {
    throw Object.assign(new Error('Calendar publishing review context changed.'), { status: 409, code: 'PUBLISH_REVIEW_CONTEXT_CHANGED' });
  }
  if (Date.parse(scheduledAt) <= now) {
    throw Object.assign(new Error('Choose a future publishing time before approving this calendar day.'), { status: 422, code: 'PUBLISH_SCHEDULE_PAST' });
  }
  if (scheduledAt.slice(0, 10) !== campaignDate) {
    throw Object.assign(new Error('Publishing time must match the reviewed campaign date.'), { status: 422, code: 'PUBLISH_SCHEDULE_DATE_MISMATCH' });
  }
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(normalizeCalendarReviewEntry)
    .sort((a, b) => `${a.provider}:${a.calendarItemId}:${a.accountConnectionId}`.localeCompare(`${b.provider}:${b.calendarItemId}:${b.accountConnectionId}`));
  if (!entries.length) throw Object.assign(new Error('No Meta calendar entries are ready for publishing review.'), { status: 409, code: 'PUBLISH_REVIEW_EMPTY' });
  for (const entry of entries) {
    if (Date.parse(entry.imageUrlExpiresAt) <= Date.parse(scheduledAt) + 10 * 60 * 1000) {
      throw Object.assign(new Error('The approved artwork URL expires before the scheduled dispatch window.'), { status: 409, code: 'PUBLISH_ASSET_URL_EXPIRES_TOO_SOON' });
    }
  }
  const calendarDaySnapshotHash = cleanString(raw.calendarDaySnapshotHash || raw.calendar_day_snapshot_hash, 80)
    || sha256Hex(canonicalJson(entries.map((entry) => ({
      calendarItemId: entry.calendarItemId,
      reviewEntryId: entry.reviewEntryId,
      calendarCreatedAt: entry.calendarCreatedAt,
      calendarSnapshotHash: entry.calendarSnapshotHash,
      provider: entry.provider,
      draftId: entry.draftId,
      accountConnectionId: entry.accountConnectionId,
      providerAccountId: entry.providerAccountId,
    }))));
  if (!/^[a-f0-9]{64}$/.test(calendarDaySnapshotHash)) {
    throw Object.assign(new Error('Calendar publishing review context is incomplete.'), { status: 409, code: 'PUBLISH_REVIEW_CONTEXT_REQUIRED' });
  }
  return { userId: trustedUserId, podId: trustedPodId, campaignDate, scheduledAt, timezone, calendarDaySnapshotHash, entries };
}

function fingerprintContext(context) {
  return sha256Hex(canonicalJson({
    userId: context.userId,
    podId: context.podId,
    campaignDate: context.campaignDate,
    scheduledAt: context.scheduledAt,
    timezone: context.timezone,
    calendarDaySnapshotHash: context.calendarDaySnapshotHash,
    entries: context.entries.map((entry) => ({
      calendarItemId: entry.calendarItemId,
      calendarCreatedAt: entry.calendarCreatedAt,
      calendarSnapshotHash: entry.calendarSnapshotHash,
      provider: entry.provider,
      draftId: entry.draftId,
      captionHash: sha256Hex(entry.caption),
      contentVersion: entry.contentVersion,
      creativeApprovalId: entry.creativeApprovalId,
      creativeApprovedAt: entry.creativeApprovedAt,
      accountConnectionId: entry.accountConnectionId,
      providerAccountId: entry.providerAccountId,
      assetManifestHash: entry.assetManifestHash,
      outputHash: entry.outputHash,
      imageUrl: entry.imageUrl,
      imageUrlExpiresAt: entry.imageUrlExpiresAt,
    })),
  }));
}

export function createRpcMetaOrganicCalendarPublishingStore({ rpc = rpcWithServiceRole } = {}) {
  return {
    async loadCalendarPublishingReviewContext(input) {
      return rpc('prepare_meta_organic_calendar_publish_review', {
        p_user_id: input.userId,
        p_pod_id: input.podId,
        p_scheduled_date: input.scheduledDate,
      });
    },
    async persistPublishingApproval(approval) {
      return rpc('persist_meta_organic_publish_approval', { p_approval: approval });
    },
    async enqueue(proposal) {
      return rpc('enqueue_meta_organic_publish_job', { p_proposal: proposal });
    },
    async confirmCalendarPublishingReview(request) {
      return rpc('confirm_meta_organic_calendar_publish_review', { p_request: request });
    },
  };
}

export async function prepareCalendarPublishingReview({
  accessToken,
  user,
  input,
  store = createRpcMetaOrganicCalendarPublishingStore(),
  now = Date.now(),
  env = process.env,
} = {}) {
  const podId = cleanString(input?.podId, 120);
  const scheduledDate = dateOnly(input?.scheduledDate || input?.campaignDate);
  if (!user?.id || !accessToken || !podId || !scheduledDate) {
    throw Object.assign(new Error('Choose a saved calendar date before preparing publishing review.'), { status: 400, code: 'PUBLISH_REVIEW_INPUT_REQUIRED' });
  }
  if (typeof store.loadCalendarPublishingReviewContext !== 'function') {
    throw Object.assign(new Error('Calendar publishing review storage is unavailable.'), { status: 503, code: 'PUBLISH_REVIEW_UNAVAILABLE' });
  }
  const rawContext = await store.loadCalendarPublishingReviewContext({ userId: user.id, podId, scheduledDate, accessToken });
  const context = normalizeCalendarReviewContext(rawContext, { userId: user.id, podId, scheduledDate, now });
  const fingerprint = fingerprintContext(context);
  const approvalIds = Object.fromEntries(context.entries.map((entry) => [entry.reviewEntryId, crypto.randomUUID()]));
  const tokenPayload = {
    version: META_ORGANIC_CALENDAR_REVIEW_TOKEN_VERSION,
    userId: user.id,
    podId,
    campaignDate: context.campaignDate,
    scheduledAt: context.scheduledAt,
    timezone: context.timezone,
    contextFingerprint: fingerprint,
    calendarDaySnapshotHash: context.calendarDaySnapshotHash,
    approvalIds,
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + REVIEW_TTL_MS).toISOString(),
  };
  return {
    preparationToken: signToken(tokenPayload, env),
    contextFingerprint: fingerprint,
    expiresAt: tokenPayload.expiresAt,
    scheduledAt: context.scheduledAt,
    timezone: context.timezone,
    campaignDate: context.campaignDate,
    calendarDaySnapshotHash: context.calendarDaySnapshotHash,
    entries: context.entries.map((entry) => ({
      reviewEntryId: entry.reviewEntryId,
      calendarItemId: entry.calendarItemId,
      calendarSnapshotHash: entry.calendarSnapshotHash,
      provider: entry.provider,
      accountConnectionId: entry.accountConnectionId,
      providerAccountId: entry.providerAccountId,
      accountLabel: entry.accountLabel,
      caption: entry.caption,
      imageUrl: entry.imageUrl,
      imageUrlExpiresAt: entry.imageUrlExpiresAt,
      outputHash: entry.outputHash,
      assetManifestHash: entry.assetManifestHash,
    })),
  };
}

export async function confirmCalendarPublishingReview({
  accessToken,
  user,
  input,
  store = createRpcMetaOrganicCalendarPublishingStore(),
  now = Date.now(),
  env = process.env,
} = {}) {
  const token = verifyCalendarPublishingReviewToken(input?.preparationToken, env, now);
  const podId = cleanString(input?.podId, 120);
  const scheduledDate = dateOnly(input?.scheduledDate || input?.campaignDate);
  if (!user?.id || token.userId !== user.id || token.podId !== podId || token.campaignDate !== scheduledDate) {
    throw Object.assign(new Error('Publishing review does not belong to this calendar date.'), { status: 403, code: 'PUBLISH_REVIEW_TENANT_MISMATCH' });
  }
  const acknowledged = new Set(Array.isArray(input?.loadedEntryIds) ? input.loadedEntryIds.map((id) => cleanString(id, 80)) : []);
  const rawContext = await store.loadCalendarPublishingReviewContext({ userId: user.id, podId, scheduledDate, accessToken });
  const context = normalizeCalendarReviewContext(rawContext, { userId: user.id, podId, scheduledDate, now });
  if (context.scheduledAt !== token.scheduledAt || context.timezone !== token.timezone || fingerprintContext(context) !== token.contextFingerprint) {
    throw Object.assign(new Error('Calendar publishing review changed. Prepare it again.'), { status: 409, code: 'PUBLISH_REVIEW_STALE' });
  }
  const missingLoads = context.entries.filter((entry) => !acknowledged.has(entry.reviewEntryId));
  if (missingLoads.length) {
    throw Object.assign(new Error('Review every rendered image before confirming publishing.'), { status: 422, code: 'PUBLISH_REVIEW_IMAGE_LOAD_REQUIRED' });
  }
  const approvedAt = new Date(now).toISOString();
  const approvals = context.entries.map((entry) => ({
    id: token.approvalIds[entry.reviewEntryId],
    provider: entry.provider,
    userId: user.id,
    podId,
    draftId: entry.draftId,
    accountConnectionId: entry.accountConnectionId,
    contentVersion: entry.contentVersion,
    assetManifestHash: entry.assetManifestHash,
    campaignDate: context.campaignDate,
    scheduledAt: context.scheduledAt,
    timezone: context.timezone,
    calendarItemId: entry.calendarItemId,
    reviewEntryId: entry.reviewEntryId,
    calendarSnapshotHash: entry.calendarSnapshotHash,
    calendarDaySnapshotHash: context.calendarDaySnapshotHash,
    contextFingerprint: token.contextFingerprint,
    status: 'approved',
    approvedAt,
    approvedBy: user.id,
  }));
  if (typeof store.confirmCalendarPublishingReview === 'function') {
    const result = await store.confirmCalendarPublishingReview({
      userId: user.id,
      podId,
      campaignDate: context.campaignDate,
      scheduledAt: context.scheduledAt,
      timezone: context.timezone,
      calendarDaySnapshotHash: context.calendarDaySnapshotHash,
      contextFingerprint: token.contextFingerprint,
      approvals,
    });
    return {
      status: result?.status || 'queue_blocked',
      queued: Array.isArray(result?.queued) ? result.queued : [],
      failures: Array.isArray(result?.failures) ? result.failures : [],
      scheduledAt: context.scheduledAt,
      timezone: context.timezone,
    };
  }
  const result = await enqueueExplicitMetaOrganicPublishingApprovals({ approvals, store });
  if (result.status !== 'queued') {
    return { status: result.status, queued: result.queued, failures: result.failures, scheduledAt: context.scheduledAt, timezone: context.timezone };
  }
  return { status: 'queued', queued: result.queued, failures: [], scheduledAt: context.scheduledAt, timezone: context.timezone };
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

// Small actual-schema authenticated loader used by tests and as a fallback probe;
// durable export and connection proof remain service/RPC-owned.
export async function loadOwnedCalendarRows({ accessToken, userId, podId, scheduledDate }) {
  const pod = await loadOwnedPod(accessToken, podId);
  if (!pod) throw Object.assign(new Error('Pod not found.'), { status: 404, code: 'PUBLISH_REVIEW_POD_NOT_FOUND' });
  const rows = await readRows(await supabaseAuthedGet(`/rest/v1/calendar_items?pod_id=eq.${encodeURIComponent(podId)}&scheduled_date=eq.${encodeURIComponent(scheduledDate)}&select=*&order=created_at.asc,id.asc`, accessToken), 'Calendar rows could not be loaded.');
  return rows.map((row) => ({ ...row, user_id: userId, pod_id: podId }));
}
