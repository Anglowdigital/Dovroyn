import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import analyzeHandler from '../api/ai/analyze.js';
import { runMetaOrganicScheduler } from '../api/_lib/metaOrganicScheduler.js';
import {
  confirmCalendarPublishingReview,
  prepareCalendarPublishingReview,
} from '../api/_lib/metaOrganicCalendarPublishingReview.js';
import { validatePodSetup } from '../src/lib/podSetup.js';

const env = Object.freeze({
  META_CALENDAR_PUBLISH_REVIEW_TOKEN_SECRET: 'release-acceptance-calendar-secret',
});

const user = Object.freeze({ id: 'release-user' });
const podId = 'release-pod';
const scheduledDate = '2098-10-12';

function entry(overrides = {}) {
  return {
    calendarItemId: overrides.calendarItemId || '00000000-0000-4000-8000-000000001001',
    calendarCreatedAt: '2098-10-01T00:00:00.000Z',
    calendarSnapshotHash: overrides.calendarSnapshotHash || '1'.repeat(64),
    provider: overrides.provider || 'facebook',
    draftId: overrides.draftId || '00000000-0000-4000-8000-000000002001',
    caption: overrides.caption || 'Exact release caption\nwith line break',
    contentVersion: overrides.contentVersion || 'release-content-v1',
    creativeApprovalId: overrides.creativeApprovalId || '00000000-0000-4000-8000-000000003001',
    creativeApprovedAt: '2098-10-02T00:00:00.000Z',
    accountConnectionId: overrides.accountConnectionId || '00000000-0000-4000-8000-000000004001',
    providerAccountId: overrides.providerAccountId || '101',
    accountLabel: overrides.accountLabel || 'Release Page',
    assetManifestHash: overrides.assetManifestHash || 'a'.repeat(64),
    outputHash: overrides.outputHash || 'b'.repeat(64),
    imageUrl: overrides.imageUrl || 'https://cdn.example.test/release-a.jpg',
    imageUrlExpiresAt: overrides.imageUrlExpiresAt || '2098-10-12T12:30:00.000Z',
  };
}

function context({ entries = null, calendarDaySnapshotHash = 'f'.repeat(64), scheduledAt = '2098-10-12T12:00:00.000Z' } = {}) {
  return {
    userId: user.id,
    podId,
    scheduledDate,
    scheduledAt,
    timezone: 'UTC',
    calendarDaySnapshotHash,
    entries: entries || [
      entry(),
      entry({
        calendarItemId: '00000000-0000-4000-8000-000000001001',
        accountConnectionId: '00000000-0000-4000-8000-000000004002',
        providerAccountId: '201',
        accountLabel: 'Second Release Page',
        assetManifestHash: 'c'.repeat(64),
        outputHash: 'd'.repeat(64),
        imageUrl: 'https://cdn.example.test/release-b.jpg',
      }),
      entry({
        calendarItemId: '00000000-0000-4000-8000-000000001002',
        accountConnectionId: '00000000-0000-4000-8000-000000004001',
        providerAccountId: '101',
        accountLabel: 'Release Page',
        draftId: '00000000-0000-4000-8000-000000002002',
        contentVersion: 'release-content-v2',
        assetManifestHash: 'e'.repeat(64),
        outputHash: '0'.repeat(64),
        imageUrl: 'https://cdn.example.test/release-c.jpg',
      }),
    ],
  };
}

function releaseStore(initial = context()) {
  let current = initial;
  const persisted = [];
  const jobs = [];
  return {
    persisted,
    jobs,
    setContext(next) { current = next; },
    async loadCalendarPublishingReviewContext() {
      return current;
    },
    async confirmCalendarPublishingReview(request) {
      if (request.approvals.length !== current.entries.length) {
        throw Object.assign(new Error('atomic confirm requires all reviewed accounts'), { code: 'PUBLISH_REVIEW_CONTEXT_CHANGED' });
      }
      persisted.push(...request.approvals);
      jobs.push(...request.approvals.map((approval, index) => ({
        id: `job-${index + 1}`,
        state: 'queued',
        provider: approval.provider,
        accountConnectionId: approval.accountConnectionId,
        campaignDate: approval.campaignDate,
        scheduledAt: approval.scheduledAt,
        approvalId: approval.id,
      })));
      return { status: 'queued', queued: jobs, failures: [] };
    },
  };
}

test('release setup accepts one URL-only source and an optional logo without requiring photos', () => {
  assert.equal(validatePodSetup({ sourceType: 'website', sourceUrl: 'https://brand.example', logoCount: 0, photoCount: 0 }), '');
  assert.equal(validatePodSetup({ sourceType: 'website', sourceUrl: 'https://brand.example', logoCount: 1, photoCount: 0 }), '');
  assert.match(validatePodSetup({ sourceType: 'website', sourceUrl: '', logoCount: 1, photoCount: 0 }), /primary URL/);
  assert.match(validatePodSetup({ sourceType: 'website', sourceUrl: 'https://brand.example', logoCount: 2, photoCount: 0 }), /no more than one/);
});

test('analysis route keeps source-first evidence ahead of AI generation', () => {
  const source = readFileSync(new URL('../api/ai/analyze.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('fetchWebsiteIntelligence(requestedSourceUrl)') < source.indexOf('createOpenAIResponse({'));
  assert.ok(source.indexOf('const multimodalContent = [{ type:') < source.indexOf('cleanImages.forEach'));
  assert.match(source, /Allowed evidence labels: \$\{sourceReferences\.join\(', '\)\}/);
  assert.match(source, /finalizePodAnalysis\(accessToken, podId, analysis\)/);
});

test('analysis handler rejects URL-source pods that have not saved a primary URL before AI analysis', async () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  process.env.VITE_SUPABASE_URL = 'https://supabase.example.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
  global.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === '/auth/v1/user') {
      return new Response(JSON.stringify({ id: user.id }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/rest/v1/pods') {
      return new Response(JSON.stringify([{ id: podId, user_id: user.id, source_type: 'website', source_url: '', pod_name: 'Release Pod' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer release-token' },
      body: { podId },
    };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
      setHeader() {},
    };
    await analyzeHandler(req, res);
    assert.equal(res.statusCode, 422);
    assert.match(res.body.error, /one primary source URL/);
  } finally {
    global.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test('release calendar review requires exact image acknowledgement for every account and queues atomically for one UTC time', async () => {
  const store = releaseStore();
  const prepared = await prepareCalendarPublishingReview({
    accessToken: 'release-token',
    user,
    input: { podId, scheduledDate },
    store,
    now: Date.parse('2098-10-10T00:00:00.000Z'),
    env,
  });
  assert.equal(prepared.entries.length, 3);
  assert.equal(new Set(prepared.entries.map((item) => item.reviewEntryId)).size, 3);
  assert.equal(new Set(prepared.entries.map((item) => item.accountConnectionId)).size, 2, 'same account may appear on more than one reviewed row');

  await assert.rejects(
    () => confirmCalendarPublishingReview({
      accessToken: 'release-token',
      user,
      input: {
        podId,
        scheduledDate,
        preparationToken: prepared.preparationToken,
        loadedEntryIds: prepared.entries.slice(0, 2).map((item) => item.reviewEntryId),
      },
      store,
      now: Date.parse('2098-10-10T00:01:00.000Z'),
      env,
    }),
    /Review every rendered image/,
  );

  const result = await confirmCalendarPublishingReview({
    accessToken: 'release-token',
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
  assert.equal(store.persisted.length, 3);
  assert.deepEqual([...new Set(store.persisted.map((approval) => approval.scheduledAt))], ['2098-10-12T12:00:00.000Z']);
  assert.deepEqual(store.jobs.map((job) => job.state), ['queued', 'queued', 'queued']);
});

test('release calendar confirmation rejects concurrent edits before queueing anything', async () => {
  const store = releaseStore();
  const prepared = await prepareCalendarPublishingReview({
    accessToken: 'release-token',
    user,
    input: { podId, scheduledDate },
    store,
    now: Date.parse('2098-10-10T00:00:00.000Z'),
    env,
  });
  const edited = context({
    calendarDaySnapshotHash: '9'.repeat(64),
    entries: context().entries.map((item, index) => index === 0 ? { ...item, caption: 'Edited after review' } : item),
  });
  store.setContext(edited);
  await assert.rejects(
    () => confirmCalendarPublishingReview({
      accessToken: 'release-token',
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
    }),
    /changed/,
  );
  assert.equal(store.persisted.length, 0);
  assert.equal(store.jobs.length, 0);
});

test('release scheduler stays dormant before constructing provider or touching storage', async () => {
  const result = await runMetaOrganicScheduler({
    req: { headers: {} },
    schedulerConfig: { enabled: false, secretConfigured: false, secret: '', batchLimit: 5, budgetMs: 25_000 },
    providerFactory: () => assert.fail('disabled scheduler must not construct provider'),
    store: { readiness: async () => assert.fail('disabled scheduler must not read storage') },
  });
  assert.deepEqual(result, { status: 'disabled', reason: 'scheduler_disabled' });
});

test('content UI gates exact Meta artwork review to Meta posts with available saved targets', () => {
  const source = readFileSync(new URL('../src/pages/PodWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(source, /const metaPost = isMetaOrganicProvider\(post\.platformKey\)/);
  assert.match(source, /const completeCurrentTargets = currentTargets\.length > 0 && currentTargets\.length === \(post\.targetAccounts \|\| \[\]\)\.length/);
  assert.match(source, /const canReviewExactMetaArtwork = metaPost && metaConnectionStatus\.available === true && completeCurrentTargets && !post\.targetSaveFailed/);
  assert.match(source, /<CreativeReview canReviewExactMetaArtwork=\{canReviewExactMetaArtwork\}/);
  assert.doesNotMatch(source, /canReviewExactMetaArtwork \? <CreativeReview/);
  assert.match(source, /This platform is planning-only in this release/);
  assert.match(source, /aria-label=\{choiceLabel\}/);
});
