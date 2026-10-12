import test from 'node:test';
import assert from 'node:assert/strict';

import {
  confirmCalendarPublishingReview,
  loadOwnedCalendarRows,
  prepareCalendarPublishingReview,
} from '../api/_lib/metaOrganicCalendarPublishingReview.js';
import { createPrepareMetaCalendarPublishingHandler } from '../api/integrations/meta/calendar/prepare.js';

const env = {
  META_CALENDAR_PUBLISH_REVIEW_TOKEN_SECRET: 'calendar-review-secret',
};
const user = { id: 'user-calendar-1' };
const podId = 'pod-calendar-1';
const scheduledDate = '2098-10-12';
const uuidA = '00000000-0000-4000-8000-000000000101';
const uuidB = '00000000-0000-4000-8000-000000000201';

function entry(overrides = {}) {
  return {
    calendarItemId: overrides.calendarItemId || uuidA,
    calendarCreatedAt: '2098-10-01T00:00:00.000Z',
    provider: overrides.provider || 'facebook',
    draftId: overrides.draftId || 'draft-facebook',
    caption: overrides.caption || 'Exact caption\nkept',
    contentVersion: overrides.contentVersion || 'draft-facebook:v1',
    creativeApprovalId: overrides.creativeApprovalId || 'creative-approval-facebook',
    creativeApprovedAt: '2098-10-01T02:00:00.000Z',
    accountConnectionId: overrides.accountConnectionId || uuidB,
    providerAccountId: overrides.providerAccountId || '101',
    accountLabel: overrides.accountLabel || 'Main Page',
    assetManifestHash: overrides.assetManifestHash || 'a'.repeat(64),
    outputHash: overrides.outputHash || 'b'.repeat(64),
    imageUrl: overrides.imageUrl || 'https://cdn.example.test/export-facebook.jpg',
    imageUrlExpiresAt: overrides.imageUrlExpiresAt || '2098-10-12T12:30:00.000Z',
  };
}

function context(overrides = {}) {
  return {
    userId: user.id,
    podId,
    scheduledDate,
    scheduledAt: overrides.scheduledAt || '2098-10-12T12:00:00.000Z',
    timezone: 'UTC',
    entries: overrides.entries || [
      entry(),
      entry({
        calendarItemId: '00000000-0000-4000-8000-000000000102',
        provider: 'instagram',
        draftId: 'draft-instagram',
        contentVersion: 'draft-instagram:v1',
        creativeApprovalId: 'creative-approval-instagram',
        accountConnectionId: '00000000-0000-4000-8000-000000000202',
        providerAccountId: '201',
        accountLabel: 'Main Instagram',
        assetManifestHash: 'c'.repeat(64),
        outputHash: 'd'.repeat(64),
        imageUrl: 'https://cdn.example.test/export-instagram.jpg',
      }),
    ],
  };
}

function storeHarness({ mutateOnConfirm, persistMode = 'normal' } = {}) {
  const calls = [];
  let prepared = context();
  return {
    calls,
    jobs: [],
    setContext(next) { prepared = next; },
    async loadCalendarPublishingReviewContext() {
      calls.push(['load']);
      return mutateOnConfirm && calls.filter((call) => call[0] === 'load').length > 1 ? mutateOnConfirm(prepared) : prepared;
    },
    async persistPublishingApproval(approval) {
      calls.push(['persist', approval]);
      if (persistMode === 'missing-time') {
        const { scheduledAt, ...withoutTime } = approval;
        return withoutTime;
      }
      return { ...approval };
    },
    async enqueue(proposal) {
      calls.push(['enqueue', proposal]);
      this.jobs.push(proposal);
      return { ...proposal, id: `job-${this.jobs.length}`, duplicate: false };
    },
  };
}

test('prepare then confirm records explicit per-account approvals and queues exact scheduled time', async () => {
  const store = storeHarness();
  const prepared = await prepareCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate },
    store,
    now: Date.parse('2098-10-10T00:00:00.000Z'),
    env,
  });

  assert.equal(prepared.scheduledAt, '2098-10-12T12:00:00.000Z');
  assert.equal(prepared.timezone, 'UTC');
  assert.equal(prepared.entries.length, 2);
  assert.ok(prepared.entries.every((item) => /^[a-f0-9]{64}$/.test(item.reviewEntryId)), 'review entry ids stay bounded for UUID inputs');
  assert.match(prepared.entries[0].imageUrl, /^https:\/\/cdn\.example\.test/);

  const result = await confirmCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: {
      podId,
      scheduledDate,
      preparationToken: prepared.preparationToken,
      loadedEntryIds: prepared.entries.map((item) => item.reviewEntryId),
    },
    store,
    now: Date.parse('2098-10-10T00:01:00.000Z'),
    env,
  });

  assert.equal(result.status, 'queued', JSON.stringify(result.failures));
  assert.equal(store.jobs.length, 2);
  assert.deepEqual(store.jobs.map((job) => job.scheduledAt), ['2098-10-12T12:00:00.000Z', '2098-10-12T12:00:00.000Z']);
  assert.deepEqual(store.calls.filter((call) => call[0] === 'persist').map((call) => call[1].timezone), ['UTC', 'UTC']);
});

test('review entry ids and approval ids stay unique for same account across multiple calendar items', async () => {
  const sameAccount = '00000000-0000-4000-8000-000000000301';
  const store = storeHarness();
  store.setContext(context({
    entries: [
      entry({
        calendarItemId: '00000000-0000-4000-8000-000000000111',
        draftId: '00000000-0000-4000-8000-000000000211',
        contentVersion: 'same-account-calendar-a:v1',
        accountConnectionId: sameAccount,
        assetManifestHash: '1'.repeat(64),
        outputHash: '2'.repeat(64),
        imageUrl: 'https://cdn.example.test/same-account-a.jpg',
      }),
      entry({
        calendarItemId: '00000000-0000-4000-8000-000000000112',
        draftId: '00000000-0000-4000-8000-000000000212',
        contentVersion: 'same-account-calendar-b:v1',
        accountConnectionId: sameAccount,
        assetManifestHash: '3'.repeat(64),
        outputHash: '4'.repeat(64),
        imageUrl: 'https://cdn.example.test/same-account-b.jpg',
      }),
    ],
  }));
  const prepared = await prepareCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate },
    store,
    now: Date.parse('2098-10-10T00:00:00.000Z'),
    env,
  });
  assert.equal(new Set(prepared.entries.map((item) => item.accountConnectionId)).size, 1);
  assert.equal(new Set(prepared.entries.map((item) => item.reviewEntryId)).size, 2);

  const result = await confirmCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: {
      podId,
      scheduledDate,
      preparationToken: prepared.preparationToken,
      loadedEntryIds: prepared.entries.map((item) => item.reviewEntryId),
    },
    store,
    now: Date.parse('2098-10-10T00:01:00.000Z'),
    env,
  });
  assert.equal(result.status, 'queued');
  const approvalIds = store.calls.filter((call) => call[0] === 'persist').map((call) => call[1].id);
  assert.equal(new Set(approvalIds).size, 2, 'approval ids are keyed by reviewEntryId, not accountConnectionId');
  assert.deepEqual(store.jobs.map((job) => job.accountConnectionId), [sameAccount, sameAccount]);
});

test('confirmation rejects stale context, forged tenant and unloaded rendered images', async () => {
  const store = storeHarness();
  const prepared = await prepareCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate },
    store,
    now: Date.parse('2098-10-10T00:00:00.000Z'),
    env,
  });

  await assert.rejects(() => confirmCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId: 'other-pod', scheduledDate, preparationToken: prepared.preparationToken, loadedEntryIds: prepared.entries.map((item) => item.reviewEntryId) },
    store,
    now: Date.parse('2098-10-10T00:01:00.000Z'),
    env,
  }), /does not belong/);

  await assert.rejects(() => confirmCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate, preparationToken: prepared.preparationToken, loadedEntryIds: [prepared.entries[0].reviewEntryId] },
    store,
    now: Date.parse('2098-10-10T00:01:00.000Z'),
    env,
  }), /Review every rendered image/);

  const staleStore = storeHarness({ mutateOnConfirm: (current) => ({ ...current, entries: current.entries.map((item, index) => index ? item : { ...item, caption: 'Changed caption' }) }) });
  const stalePrepared = await prepareCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate },
    store: staleStore,
    now: Date.parse('2098-10-10T00:00:00.000Z'),
    env,
  });
  await assert.rejects(() => confirmCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate, preparationToken: stalePrepared.preparationToken, loadedEntryIds: stalePrepared.entries.map((item) => item.reviewEntryId) },
    store: staleStore,
    now: Date.parse('2098-10-10T00:01:00.000Z'),
    env,
  }), /changed/);
  assert.equal(staleStore.jobs.length, 0);
});

test('durable approval must echo the exact scheduledAt before enqueueing', async () => {
  const store = storeHarness({ persistMode: 'missing-time' });
  const prepared = await prepareCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate },
    store,
    now: Date.parse('2098-10-10T00:00:00.000Z'),
    env,
  });
  const result = await confirmCalendarPublishingReview({
    accessToken: 'token',
    user,
    input: { podId, scheduledDate, preparationToken: prepared.preparationToken, loadedEntryIds: prepared.entries.map((item) => item.reviewEntryId) },
    store,
    now: Date.parse('2098-10-10T00:01:00.000Z'),
    env,
  });
  assert.equal(result.status, 'queue_blocked');
  assert.equal(result.failures[0].reason, 'PUBLISH_SCHEDULE_APPROVAL_REQUIRED');
  assert.equal(store.jobs.length, 0);
});

test('actual-schema calendar rows are loaded via owned pod without invented user_id column', async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(rawUrl);
    requests.push(url.pathname + url.search);
    if (url.pathname === '/rest/v1/pods') return new Response(JSON.stringify([{ id: podId, pod_name: 'Owned Pod' }]), { status: 200 });
    if (url.pathname === '/rest/v1/calendar_items') {
      return new Response(JSON.stringify([{ id: 'cal-1', pod_id: podId, scheduled_date: scheduledDate, platform: 'facebook', caption: 'Draft', status: 'draft' }]), { status: 200 });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  const rows = await loadOwnedCalendarRows({ accessToken: 'token', userId: user.id, podId, scheduledDate });
  assert.equal(rows[0].user_id, user.id);
  assert.equal(rows[0].pod_id, podId);
  assert.ok(requests.some((request) => request.includes('/rest/v1/calendar_items')));
});

test('missing calendar publishing review RPC maps to unavailable instead of leaked schema text', async () => {
  const handler = createPrepareMetaCalendarPublishingHandler({
    verifySupabaseUser: async () => user,
    prepareCalendarPublishingReview: async () => {
      const error = new Error('Could not find the function public.prepare_meta_organic_calendar_publish_review in the schema cache');
      error.status = 404;
      throw error;
    },
  });
  const response = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method: 'POST', headers: { authorization: 'Bearer token' }, body: { podId, scheduledDate } }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'PUBLISH_REVIEW_UNAVAILABLE');
  assert.doesNotMatch(response.body.error, /schema cache|prepare_meta_organic/i);
});
