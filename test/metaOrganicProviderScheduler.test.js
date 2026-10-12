import test from 'node:test';
import assert from 'node:assert/strict';

import { createMetaGraphOrganicProvider } from '../api/_lib/metaOrganicProvider.js';
import { SafeRetryablePublishError, UnknownOutcomePublishError } from '../api/_lib/metaOrganicPublisher.js';
import {
  authorizeMetaOrganicScheduler,
  getMetaOrganicSchedulerConfig,
  runMetaOrganicScheduler,
} from '../api/_lib/metaOrganicScheduler.js';

const config = Object.freeze({ graphVersion: 'v26.0' });

function response(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function privateContext(overrides = {}) {
  const calls = [];
  return {
    provider: overrides.provider || 'facebook',
    providerAccountId: overrides.providerAccountId || '101',
    accountConnectionId: overrides.accountConnectionId || 'connection-1',
    tokenKind: 'page',
    accessToken: 'page-token-secret',
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    calls,
    async assertLease(stage) {
      calls.push(['lease', stage]);
      if (overrides.rejectLease) throw Object.assign(new Error('expired'), { code: 'PUBLISH_LEASE_EXPIRED' });
      return { ok: true };
    },
    async recordStage(stage, receipt) {
      calls.push(['stage', stage, receipt]);
      if (overrides.rejectStage) throw Object.assign(new Error('stage failed'), { code: 'PUBLISH_STAGE_FAILED' });
      return { ok: true };
    },
  };
}

test('Facebook adapter posts exact caption and URL to selected Page with token only in header', async () => {
  const requests = [];
  const provider = createMetaGraphOrganicProvider({
    config,
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(url.origin, 'https://graph.facebook.com');
      assert.equal(url.pathname, '/v26.0/101/photos');
      assert.equal(url.searchParams.has('access_token'), false);
      assert.equal(options.headers.Authorization, 'Bearer page-token-secret');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('caption'), 'raw caption\nkept');
      assert.equal(body.get('url'), 'https://cdn.example.test/export.jpg');
      assert.equal(body.get('published'), 'true');
      return response(200, { id: '123', post_id: '101_555', permalink_url: 'https://www.facebook.com/101_555' });
    },
  });
  const ctx = privateContext();
  const receipt = await provider.publishFacebookPagePhoto({
    accountId: '101',
    assetUrl: 'https://cdn.example.test/export.jpg',
    caption: 'raw caption\nkept',
  }, ctx);

  assert.equal(requests.length, 1);
  assert.deepEqual(receipt, {
    provider: 'facebook',
    providerAccountId: '101',
    providerPostId: '101_555',
    photoId: '123',
    permalink: 'https://www.facebook.com/101_555',
  });
  assert.deepEqual(ctx.calls.map((call) => call[1]), ['facebook_photo_before_write', 'facebook_photo_published']);
});

test('Facebook adapter does not conflate a photo id with a proven published post id', async () => {
  const provider = createMetaGraphOrganicProvider({
    config,
    fetch: async () => response(200, { id: '123' }),
  });
  await assert.rejects(
    () => provider.publishFacebookPagePhoto({ accountId: '101', assetUrl: 'https://cdn.example.test/export.jpg', caption: 'caption' }, privateContext()),
    (error) => error instanceof UnknownOutcomePublishError && error.receipt.photoId === '123',
  );
});

test('provider rejects non-Meta-shaped identifiers before durable success', async () => {
  const badFacebook = createMetaGraphOrganicProvider({
    config,
    fetch: async () => response(200, { id: 'photo-slug', post_id: 'not-a-page-post' }),
  });
  await assert.rejects(
    () => badFacebook.publishFacebookPagePhoto({ accountId: '101', assetUrl: 'https://cdn.example.test/export.jpg', caption: 'caption' }, privateContext()),
    (error) => error instanceof UnknownOutcomePublishError && !error.receipt.providerPostId && !error.receipt.photoId,
  );

  const badInstagram = createMetaGraphOrganicProvider({
    config,
    fetch: async () => response(200, { id: 'container-slug' }),
  });
  await assert.rejects(
    () => badInstagram.publishInstagramImage(
      { accountId: '201', assetUrl: 'https://cdn.example.test/ig.jpg', caption: 'caption' },
      privateContext({ provider: 'instagram', providerAccountId: '201' }),
    ),
    (error) => error instanceof UnknownOutcomePublishError && !error.receipt.containerId,
  );
});

test('Instagram adapter creates, fences, polls, and publishes the same container once', async () => {
  const requests = [];
  const provider = createMetaGraphOrganicProvider({
    config,
    pollDelayMs: 0,
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.headers.Authorization, 'Bearer page-token-secret');
      if (url.pathname === '/v26.0/201/media') {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get('image_url'), 'https://cdn.example.test/ig.jpg');
        assert.equal(body.get('caption'), 'IG exact caption');
        return response(200, { id: '3001' });
      }
      if (url.pathname === '/v26.0/3001') return response(200, { status_code: 'FINISHED' });
      if (url.pathname === '/v26.0/201/media_publish') {
        assert.equal(new URLSearchParams(options.body).get('creation_id'), '3001');
        return response(200, { id: '4001', permalink: 'https://www.instagram.com/p/mediaxyz/' });
      }
      throw new Error(`unexpected ${url.pathname}`);
    },
  });
  const ctx = privateContext({ provider: 'instagram', providerAccountId: '201' });
  const receipt = await provider.publishInstagramImage({ accountId: '201', assetUrl: 'https://cdn.example.test/ig.jpg', caption: 'IG exact caption' }, ctx);

  assert.equal(receipt.providerPostId, '4001');
  assert.equal(receipt.containerId, '3001');
  assert.deepEqual(requests.map((request) => request.url.pathname), ['/v26.0/201/media', '/v26.0/3001', '/v26.0/201/media_publish']);
  assert.deepEqual(ctx.calls.map((call) => call[1]), [
    'instagram_container_before_create',
    'instagram_container_created',
    'instagram_container_poll',
    'instagram_media_before_publish',
    'instagram_media_published',
  ]);
});

test('provider stage persistence failure after a write is quarantined unknown by the adapter', async () => {
  const provider = createMetaGraphOrganicProvider({
    config,
    fetch: async () => response(200, { id: '123', post_id: '101_555' }),
  });
  await assert.rejects(
    () => provider.publishFacebookPagePhoto(
      { accountId: '101', assetUrl: 'https://cdn.example.test/export.jpg', caption: 'caption' },
      privateContext({ rejectStage: true }),
    ),
    (error) => error instanceof UnknownOutcomePublishError,
  );
});

test('provider refuses to write when private lease callbacks are missing', async () => {
  const provider = createMetaGraphOrganicProvider({
    config,
    fetch: async () => assert.fail('fetch must not run without private callbacks'),
  });
  await assert.rejects(
    () => provider.publishFacebookPagePhoto(
      { accountId: '101', assetUrl: 'https://cdn.example.test/export.jpg', caption: 'caption' },
      { provider: 'facebook', providerAccountId: '101', tokenKind: 'page', accessToken: 'page-token-secret' },
    ),
    /lease callbacks are required/,
  );
});

test('Instagram post-container read throttling is unknown with container id, not safe retry', async () => {
  let calls = 0;
  const provider = createMetaGraphOrganicProvider({
    config,
    pollDelayMs: 0,
    fetch: async (url) => {
      calls += 1;
      if (url.pathname === '/v26.0/201/media') return response(200, { id: '3002' });
      if (url.pathname === '/v26.0/3002') return response(429, { error: { message: 'slow down' } });
      throw new Error(`unexpected ${url.pathname}`);
    },
  });
  await assert.rejects(
    () => provider.publishInstagramImage(
      { accountId: '201', assetUrl: 'https://cdn.example.test/ig.jpg', caption: 'caption' },
      privateContext({ provider: 'instagram', providerAccountId: '201' }),
    ),
    (error) => error instanceof UnknownOutcomePublishError && error.receipt.containerId === '3002',
  );
  assert.equal(calls, 2);
});

test('Graph deadline covers headers-success body-hang responses', async () => {
  let signal;
  const provider = createMetaGraphOrganicProvider({
    config,
    fetch: async (_url, options) => {
      signal = options.signal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id"'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const ctx = privateContext();
  ctx.deadlineAt = new Date(Date.now() + 1100).toISOString();
  const started = Date.now();
  await assert.rejects(
    () => provider.publishFacebookPagePhoto({ accountId: '101', assetUrl: 'https://cdn.example.test/export.jpg', caption: 'caption' }, ctx),
    (error) => error instanceof UnknownOutcomePublishError && error.receipt.reason === 'OUTCOME_UNKNOWN',
  );
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 1800);
});

test('provider deadline blocks initial write before fetch and remains safely retryable', async () => {
  const provider = createMetaGraphOrganicProvider({
    config,
    fetch: async () => assert.fail('fetch must not run after expired deadline'),
  });
  const ctx = privateContext({ provider: 'instagram', providerAccountId: '201' });
  ctx.deadlineAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(
    () => provider.publishInstagramImage({ accountId: '201', assetUrl: 'https://cdn.example.test/ig.jpg', caption: 'caption' }, ctx),
    (error) => error instanceof SafeRetryablePublishError && error.code === 'REQUEST_TIMEOUT_BEFORE_WRITE',
  );
});

test('read-only reconciliation requires provider-owned object proof', async () => {
  const provider = createMetaGraphOrganicProvider({
    config,
    fetch: async (url) => {
      assert.equal(url.pathname, '/v26.0/101_555');
      return response(200, { id: '101_555', permalink_url: 'https://www.facebook.com/101_555', from: { id: '999' } });
    },
  });
  const notOwned = await provider.lookupPublishedMetaOrganicReceipt({
    provider: 'facebook',
    providerAccountId: '101',
    providerPostId: '101_555',
    dedupeKey: 'a'.repeat(64),
  }, { accessToken: 'page-token-secret', deadlineAt: new Date(Date.now() + 30_000).toISOString() });
  assert.equal(notOwned, null);
});

test('scheduler disabled and missing secret gates occur before provider/store construction', async () => {
  let constructed = false;
  const disabled = await runMetaOrganicScheduler({
    schedulerConfig: getMetaOrganicSchedulerConfig({}),
    providerFactory: () => { constructed = true; throw new Error('no provider'); },
    store: { readiness: async () => assert.fail('disabled scheduler must not read readiness') },
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(constructed, false);

  const missingSecret = await runMetaOrganicScheduler({
    schedulerConfig: getMetaOrganicSchedulerConfig({ META_ORGANIC_SCHEDULER_ENABLED: 'true' }),
    providerFactory: () => assert.fail('missing-secret scheduler must not construct provider'),
  });
  assert.deepEqual(missingSecret, { status: 'unavailable', reason: 'scheduler_authorization_required' });
});

test('scheduler accepts existing CRON_SECRET and fails closed when readiness is unavailable', async () => {
  const configWithCron = getMetaOrganicSchedulerConfig({ META_ORGANIC_SCHEDULER_ENABLED: 'true', CRON_SECRET: 'cron-secret' });
  assert.equal(authorizeMetaOrganicScheduler({ headers: { authorization: 'Bearer cron-secret' } }, configWithCron).ok, true);
  const result = await runMetaOrganicScheduler({
    req: { headers: { authorization: 'Bearer cron-secret' } },
    schedulerConfig: configWithCron,
    publisherConfig: { enabled: true, maxAttempts: 3, leaseMs: 30_000 },
    store: { readiness: async () => ({ ready: false }) },
    providerFactory: () => assert.fail('readiness failure must precede provider construction'),
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'scheduler_readiness_required' });
});
