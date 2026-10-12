import { getMetaOrganicConfig } from './metaOrganic.js';
import { SafeRetryablePublishError, UnknownOutcomePublishError } from './metaOrganicPublisher.js';

const GRAPH_HOST = 'graph.facebook.com';
const MAX_PROVIDER_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_IG_POLLS = 8;
const IG_POLL_DELAY_MS = 500;

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function providerAccountId(value) {
  const id = cleanString(value, 80);
  return /^[1-9][0-9]{0,31}$/.test(id) ? id : '';
}

function providerNumericId(value) {
  const id = cleanString(value, 80);
  return /^[1-9][0-9]{0,31}$/.test(id) ? id : '';
}

function facebookPagePostId(value, pageId) {
  const id = cleanString(value, 120);
  if (!providerNumericId(pageId)) return '';
  return new RegExp(`^${pageId}_[1-9][0-9]{0,31}$`).test(id) ? id : '';
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function remainingDeadlineMs(deadlineAt, floorMs = 1000) {
  if (!deadlineAt) return DEFAULT_TIMEOUT_MS;
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining < floorMs) {
    const error = new Error('Meta provider deadline expired.');
    error.code = 'PROVIDER_DEADLINE_EXPIRED';
    throw error;
  }
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(floorMs, remaining));
}

function graphUrl(path, config = getMetaOrganicConfig()) {
  const safePath = String(path || '').startsWith('/') ? String(path) : `/${path}`;
  const url = new URL(`https://${GRAPH_HOST}/${config.graphVersion}${safePath}`);
  if (url.hostname !== GRAPH_HOST || url.protocol !== 'https:') throw new Error('Invalid Meta Graph path.');
  return url;
}

function sanitizeErrorCode(error, fallback = 'PROVIDER_UNAVAILABLE') {
  return cleanString(error?.code || error?.cause?.code || fallback, 80).toUpperCase() || fallback;
}

async function sleep(ms) {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

function abortError() {
  const error = new Error('Meta provider request timed out.');
  error.name = 'AbortError';
  error.code = 'REQUEST_TIMEOUT';
  return error;
}

async function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function boundedJson(response, signal) {
  const reader = response.body?.getReader ? response.body.getReader() : null;
  if (!reader) {
    const text = await raceAbort(response.text(), signal);
    if (Buffer.byteLength(text) > MAX_PROVIDER_BODY_BYTES) throw Object.assign(new Error('Provider response is too large.'), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    return text ? JSON.parse(text) : {};
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('Provider response is too large.'), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function graphRequest(path, {
  method = 'GET',
  params = {},
  accessToken,
  fetch,
  config,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  beforeWrite = false,
} = {}) {
  if (!accessToken) throw Object.assign(new Error('Meta credential is unavailable.'), { code: 'PUBLISH_CREDENTIAL_CONTEXT_REQUIRED' });
  const url = graphUrl(path, config);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const options = { method, redirect: 'manual', headers };
  if (method === 'GET') {
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
  } else {
    const body = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) body.set(key, String(value));
    });
    options.headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
    options.body = body.toString();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let payload = {};
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    if (response.status >= 300 && response.status <= 399) {
      throw Object.assign(new Error('Meta provider redirect was rejected.'), { code: method === 'GET' ? 'PROVIDER_REDIRECT' : 'PROVIDER_REDIRECT_AFTER_WRITE', status: response.status });
    }
    try {
      payload = await boundedJson(response, controller.signal);
    } catch (error) {
      if (method === 'GET') throw new SafeRetryablePublishError('Meta read response could not be parsed.', 'PROVIDER_TEMPORARY_BEFORE_WRITE');
      throw Object.assign(new Error('Meta write acknowledgement could not be parsed.'), { code: 'OUTCOME_UNKNOWN', providerPayloadParseFailed: true });
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (beforeWrite || method === 'GET') throw new SafeRetryablePublishError('Meta request timed out before a write was confirmed.', 'REQUEST_TIMEOUT_BEFORE_WRITE');
      throw Object.assign(new Error('Meta provider write timeout outcome is unknown.'), { code: 'REQUEST_TIMEOUT' });
    }
    if (error instanceof SafeRetryablePublishError || error?.code === 'OUTCOME_UNKNOWN' || error?.code === 'PROVIDER_REDIRECT_AFTER_WRITE') throw error;
    if (beforeWrite || method === 'GET') throw new SafeRetryablePublishError('Meta request failed before a write was confirmed.', 'REQUEST_TIMEOUT_BEFORE_WRITE');
    throw Object.assign(new Error('Meta provider write outcome is unknown.'), { code: sanitizeErrorCode(error, 'REQUEST_TIMEOUT') });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    if (method === 'GET') throw new SafeRetryablePublishError('Meta read failed temporarily.', response.status === 429 ? 'PROVIDER_429_BEFORE_WRITE' : 'PROVIDER_TEMPORARY_BEFORE_WRITE');
    const code = response.status >= 500 ? 'PROVIDER_5XX' : 'PROVIDER_REJECTED';
    throw Object.assign(new Error('Meta write failed or is unknown.'), { code, status: response.status });
  }
  return payload;
}

function assertPrivateContext(payload, context, provider) {
  const accountId = providerAccountId(payload.accountId);
  if (!accountId || !isHttpsUrl(payload.assetUrl) || typeof payload.caption !== 'string') {
    throw Object.assign(new Error('Meta publish payload is invalid.'), { code: 'PUBLISH_PAYLOAD_INVALID' });
  }
  if (!context?.accessToken || context.provider !== provider || context.providerAccountId !== accountId || context.tokenKind !== 'page') {
    throw Object.assign(new Error('Meta publish credential is not valid for this account.'), { code: 'PUBLISH_CREDENTIAL_CONTEXT_REQUIRED' });
  }
  if (typeof context.assertLease !== 'function' || typeof context.recordStage !== 'function') {
    throw Object.assign(new Error('Meta publish lease callbacks are required.'), { code: 'PUBLISH_LEASE_CALLBACK_REQUIRED' });
  }
  return accountId;
}

function safePermalink(value) {
  return isHttpsUrl(value) ? cleanString(value, 2048) : undefined;
}

export function createMetaGraphOrganicProvider({
  fetch: fetchImpl = fetch,
  config = getMetaOrganicConfig(),
  pollDelayMs = IG_POLL_DELAY_MS,
} = {}) {
  const request = (path, options) => graphRequest(path, { ...options, fetch: fetchImpl, config });

  return {
    async publishFacebookPagePhoto(payload, privateContext) {
      const pageId = assertPrivateContext(payload, privateContext, 'facebook');
      await privateContext.assertLease('facebook_photo_before_write');
      const timeoutMs = remainingDeadlineMs(privateContext.deadlineAt);
      let result;
      try {
        result = await request(`/${pageId}/photos`, {
          method: 'POST',
          accessToken: privateContext.accessToken,
          timeoutMs,
          params: {
            url: payload.assetUrl,
            caption: payload.caption,
            published: 'true',
          },
        });
      } catch (error) {
        if (error?.code === 'PROVIDER_DEADLINE_EXPIRED') {
          throw new SafeRetryablePublishError('Meta provider deadline expired before Facebook write.', 'REQUEST_TIMEOUT_BEFORE_WRITE');
        }
        throw new UnknownOutcomePublishError('Facebook Page photo publish outcome is unknown.', {
          provider: 'facebook',
          providerAccountId: pageId,
          operation: 'facebook_page_photo',
          reason: sanitizeErrorCode(error, 'OUTCOME_UNKNOWN'),
        });
      }
      const photoId = providerNumericId(result?.id);
      const postId = facebookPagePostId(result?.post_id || result?.postId, pageId);
      if (!postId) {
        throw new UnknownOutcomePublishError('Facebook Page photo response did not include a durable id.', {
          provider: 'facebook',
          providerAccountId: pageId,
          operation: 'facebook_page_photo',
          photoId,
          reason: 'MISSING_PROVIDER_RECEIPT',
        });
      }
      try {
        await privateContext.recordStage('facebook_photo_published', { provider: 'facebook', providerAccountId: pageId, photoId, providerPostId: postId });
      } catch (error) {
        throw new UnknownOutcomePublishError('Facebook Page photo publish checkpoint failed after provider acknowledgement.', {
          provider: 'facebook',
          providerAccountId: pageId,
          operation: 'facebook_page_photo',
          providerPostId: postId,
          photoId,
          reason: sanitizeErrorCode(error, 'PROVIDER_STAGE_PERSISTENCE_FAILED'),
        });
      }
      return {
        provider: 'facebook',
        providerAccountId: pageId,
        providerPostId: postId,
        photoId,
        permalink: safePermalink(result?.permalink_url || result?.permalink),
      };
    },

    async publishInstagramImage(payload, privateContext) {
      const igUserId = assertPrivateContext(payload, privateContext, 'instagram');
      await privateContext.assertLease('instagram_container_before_create');
      let container;
      try {
        const timeoutMs = remainingDeadlineMs(privateContext.deadlineAt);
        container = await request(`/${igUserId}/media`, {
          method: 'POST',
          accessToken: privateContext.accessToken,
          timeoutMs,
          params: {
            image_url: payload.assetUrl,
            caption: payload.caption,
          },
        });
      } catch (error) {
        if (error?.code === 'PROVIDER_DEADLINE_EXPIRED') {
          throw new SafeRetryablePublishError('Meta provider deadline expired before Instagram container creation.', 'REQUEST_TIMEOUT_BEFORE_WRITE');
        }
        throw new UnknownOutcomePublishError('Instagram container creation outcome is unknown.', {
          provider: 'instagram',
          providerAccountId: igUserId,
          operation: 'instagram_media_create',
          reason: sanitizeErrorCode(error, 'OUTCOME_UNKNOWN'),
        });
      }
      const containerId = providerNumericId(container?.id);
      if (!containerId) {
        throw new UnknownOutcomePublishError('Instagram container response did not include a durable id.', {
          provider: 'instagram',
          providerAccountId: igUserId,
          operation: 'instagram_media_create',
          reason: 'MISSING_CONTAINER_ID',
        });
      }
      try {
        await privateContext.recordStage('instagram_container_created', { provider: 'instagram', providerAccountId: igUserId, containerId });
      } catch (error) {
        throw new UnknownOutcomePublishError('Instagram container checkpoint failed after provider acknowledgement.', {
          provider: 'instagram',
          providerAccountId: igUserId,
          containerId,
          operation: 'instagram_media_create',
          reason: sanitizeErrorCode(error, 'PROVIDER_STAGE_PERSISTENCE_FAILED'),
        });
      }

      let ready = false;
      for (let attempt = 0; attempt < MAX_IG_POLLS; attempt += 1) {
        await privateContext.assertLease('instagram_container_poll');
        let status;
        try {
          const timeoutMs = remainingDeadlineMs(privateContext.deadlineAt);
          status = await request(`/${containerId}`, {
            method: 'GET',
            accessToken: privateContext.accessToken,
            timeoutMs,
            params: { fields: 'status_code' },
          });
        } catch (error) {
          throw new UnknownOutcomePublishError('Instagram container status is unknown after container creation.', {
            provider: 'instagram',
            providerAccountId: igUserId,
            containerId,
            operation: 'instagram_container_status',
            reason: sanitizeErrorCode(error, 'CONTAINER_STATUS_UNKNOWN'),
          });
        }
        const statusCode = cleanString(status?.status_code || status?.statusCode, 80).toUpperCase();
        if (statusCode === 'FINISHED') {
          ready = true;
          break;
        }
        if (['ERROR', 'EXPIRED'].includes(statusCode)) {
          throw new UnknownOutcomePublishError('Instagram container is not publishable.', {
            provider: 'instagram',
            providerAccountId: igUserId,
            containerId,
            operation: 'instagram_container_status',
            reason: `CONTAINER_${statusCode}`,
          });
        }
        if (attempt < MAX_IG_POLLS - 1) await sleep(pollDelayMs);
      }
      if (!ready) {
        throw new UnknownOutcomePublishError('Instagram container did not become ready within the bounded poll window.', {
          provider: 'instagram',
          providerAccountId: igUserId,
          containerId,
          operation: 'instagram_container_status',
          reason: 'CONTAINER_NOT_READY',
        });
      }

      await privateContext.assertLease('instagram_media_before_publish');
      let published;
      try {
        const timeoutMs = remainingDeadlineMs(privateContext.deadlineAt);
        published = await request(`/${igUserId}/media_publish`, {
          method: 'POST',
          accessToken: privateContext.accessToken,
          timeoutMs,
          params: { creation_id: containerId },
        });
      } catch (error) {
        throw new UnknownOutcomePublishError('Instagram media publish outcome is unknown.', {
          provider: 'instagram',
          providerAccountId: igUserId,
          containerId,
          operation: 'instagram_media_publish',
          reason: sanitizeErrorCode(error, 'OUTCOME_UNKNOWN'),
        });
      }
      const mediaId = providerNumericId(published?.id);
      if (!mediaId) {
        throw new UnknownOutcomePublishError('Instagram publish response did not include a media id.', {
          provider: 'instagram',
          providerAccountId: igUserId,
          containerId,
          operation: 'instagram_media_publish',
          reason: 'MISSING_PROVIDER_RECEIPT',
        });
      }
      try {
        await privateContext.recordStage('instagram_media_published', { provider: 'instagram', providerAccountId: igUserId, containerId, providerPostId: mediaId });
      } catch (error) {
        throw new UnknownOutcomePublishError('Instagram publish checkpoint failed after provider acknowledgement.', {
          provider: 'instagram',
          providerAccountId: igUserId,
          containerId,
          providerPostId: mediaId,
          operation: 'instagram_media_publish',
          reason: sanitizeErrorCode(error, 'PROVIDER_STAGE_PERSISTENCE_FAILED'),
        });
      }
      return {
        provider: 'instagram',
        providerAccountId: igUserId,
        providerPostId: mediaId,
        containerId,
        permalink: safePermalink(published?.permalink),
      };
    },

    async lookupPublishedMetaOrganicReceipt(hints = {}, privateContext = {}) {
      const provider = cleanString(hints.provider, 40);
      const accountId = providerAccountId(hints.providerAccountId || privateContext.providerAccountId);
      const rawProviderPostId = hints.providerPostId || hints.mediaId || hints.postId;
      const providerPostId = provider === 'facebook'
        ? facebookPagePostId(rawProviderPostId, accountId)
        : providerNumericId(rawProviderPostId);
      if (!provider || !accountId || !providerPostId || !privateContext.accessToken) return null;
      const payload = await request(`/${providerPostId}`, {
        method: 'GET',
        accessToken: privateContext.accessToken,
        timeoutMs: remainingDeadlineMs(privateContext.deadlineAt),
        params: { fields: provider === 'instagram' ? 'id,permalink,owner' : 'id,permalink_url,from' },
      });
      const id = cleanString(payload?.id, 120);
      if (id !== providerPostId) return null;
      const ownerId = providerAccountId(payload?.from?.id || payload?.owner?.id);
      if (ownerId !== accountId) return null;
      return {
        status: 'found',
        provider,
        providerAccountId: accountId,
        providerPostId: id,
        dedupeKey: hints.dedupeKey,
        permalink: safePermalink(payload?.permalink || payload?.permalink_url),
      };
    },
  };
}
