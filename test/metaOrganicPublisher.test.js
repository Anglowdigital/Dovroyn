import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SafeRetryablePublishError,
  UnknownOutcomePublishError,
  buildMetaOrganicPublishProposal,
  createInMemoryMetaOrganicPublishStore,
  createInMemoryMetaOrganicPublishStoreWithClock,
  getMetaOrganicPublisherConfig,
  makeMetaOrganicDedupeKey,
  processNextMetaOrganicPublishJob,
  reconcileNextMetaOrganicPublishJob,
  validateMetaOrganicPublishContext,
  META_ORGANIC_PUBLISH_PERMISSIONS,
  META_ORGANIC_PUBLISHER_CONTRACT_VERSION,
  META_ORGANIC_PUBLISHER_DISABLED_REASON,
  META_ORGANIC_PUBLISHER_PROVENANCE,
  META_ORGANIC_TOKEN_KINDS,
} from '../api/_lib/metaOrganicPublisher.js';

const now = new Date('2026-10-12T03:00:00.000Z');
const userId = 'user-dovroyn';
const podId = 'pod-dovroyn';
const activeSubscription = Object.freeze({
  tier: 'starter',
  status: 'active',
  current_period_end: '2099-01-01T00:00:00.000Z',
});

function baseContext(overrides = {}) {
  const provider = overrides.provider || 'facebook';
  const accountConnectionId = overrides.accountConnectionId || `${provider}-connection-1`;
  const draftId = overrides.draftId || `${provider}-draft-1`;
  const contentVersion = overrides.contentVersion || `${draftId}:content:v1`;
  const assetManifestHash = overrides.assetManifestHash || `${draftId}:asset:sha256`;
  const approvalId = overrides.approvalId || `${draftId}:approval`;
  const campaignDate = overrides.campaignDate || '2026-10-12';
  const proposal = buildMetaOrganicPublishProposal({
    provider,
    userId,
    podId,
    draftId,
    accountConnectionId,
    contentVersion,
    assetManifestHash,
    approvalId,
    campaignDate,
    scheduledAt: overrides.scheduledAt,
  });
  return {
    proposal,
    subscription: activeSubscription,
    existingCampaignDates: overrides.existingCampaignDates || [],
    draft: {
      id: draftId,
      userId,
      podId,
      provider,
      status: 'approved',
      caption: `${provider} pilot caption`,
      contentVersion,
      ...overrides.draft,
    },
    approval: {
      id: approvalId,
      userId,
      podId,
      draftId,
      accountConnectionId,
      contentVersion,
      assetManifestHash,
      campaignDate,
      approvedAt: '2026-10-11T10:00:00.000Z',
      status: 'approved',
      ...overrides.approval,
    },
    asset: {
      userId,
      podId,
      manifestHash: assetManifestHash,
      providerReadableUrl: 'https://cdn.example.test/dovroyn/exported-image.jpg',
      status: 'exported',
      immutable: true,
      mediaType: 'image/jpeg',
      ...overrides.asset,
    },
    account: {
      id: accountConnectionId,
      userId,
      podId,
      provider,
      providerAccountId: provider === 'instagram' ? '201' : '101',
      status: 'connected',
      expiresAt: '2099-01-01T00:00:00.000Z',
      tokenKind: META_ORGANIC_TOKEN_KINDS[provider],
      grantedScopes: [...META_ORGANIC_PUBLISH_PERMISSIONS[provider]],
      ...overrides.account,
    },
  };
}

function providerAdapter(calls = [], behavior = {}) {
  return {
    async publishFacebookPagePhoto(payload) {
      calls.push({ provider: 'facebook', payload });
      if (behavior.facebook) return behavior.facebook(payload);
      return { providerPostId: `fb-post-${calls.length}`, permalink: `https://www.facebook.com/fb-post-${calls.length}` };
    },
    async publishInstagramImage(payload) {
      calls.push({ provider: 'instagram', payload });
      if (behavior.instagram) return behavior.instagram(payload);
      return { providerPostId: `ig-media-${calls.length}`, permalink: `https://www.instagram.com/p/mock${calls.length}/` };
    },
  };
}

test('publisher config is disabled by default and does not touch storage or providers', async () => {
  assert.equal(getMetaOrganicPublisherConfig({}).enabled, false);
  const providerCalls = [];
  const result = await processNextMetaOrganicPublishJob({
    config: getMetaOrganicPublisherConfig({}),
    store: { claimNext: async () => assert.fail('disabled worker must not claim jobs') },
    provider: providerAdapter(providerCalls),
    now,
  });
  assert.deepEqual(result, { status: 'disabled', reason: META_ORGANIC_PUBLISHER_DISABLED_REASON });
  assert.deepEqual(providerCalls, []);
});

test('dedupe is exact across draft, account, content, asset and date', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  const first = await store.enqueue(context.proposal);
  const duplicate = await store.enqueue({ ...context.proposal });
  const changedAsset = await store.enqueue({ ...context.proposal, assetManifestHash: 'different-asset-hash' });
  const changedApproval = await store.enqueue({ ...context.proposal, approvalId: 'replacement-approval' });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(changedApproval.duplicate, true);
  assert.equal(changedAsset.duplicate, false);
  assert.equal(store.jobs.length, 2);
  assert.notEqual(changedAsset.dedupeKey, first.dedupeKey);
  assert.equal(changedApproval.dedupeKey, first.dedupeKey);
  assert.equal(first.dedupeKey, makeMetaOrganicDedupeKey(context.proposal));
});

test('re-approval of the same delivery tuple cannot create a second deliverable after publish', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const calls = [];
  await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter(calls),
    now,
  });

  const reapproval = await store.enqueue({ ...context.proposal, approvalId: 'new-approval-row-same-delivery' });
  assert.equal(reapproval.duplicate, true);
  assert.equal(store.jobs.length, 1);
  assert.equal(calls.length, 1);
});

test('claiming is lease-bound and prevents concurrent duplicate execution', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);

  const first = await store.claimNext({ workerId: 'worker-a', now, leaseMs: 300_000 });
  const second = await store.claimNext({ workerId: 'worker-b', now, leaseMs: 300_000 });
  const afterLease = await store.claimNext({ workerId: 'worker-b', now: new Date(now.getTime() + 301_000), leaseMs: 300_000 });

  assert.equal(first.id, 'job-1');
  assert.equal(second, null);
  assert.equal(afterLease, null);
  assert.equal(store.jobs[0].state, 'unknown');
});

test('expired publish lease is quarantined unknown instead of reclaimed for dispatch', async () => {
  const context = baseContext();
  let clock = now.getTime();
  const store = createInMemoryMetaOrganicPublishStoreWithClock([context], () => clock);
  await store.enqueue(context.proposal);

  const leased = await store.claimNext({ workerId: 'worker-a', now, leaseMs: 300_000 });
  clock = now.getTime() + 301_000;
  const reclaimed = await store.claimNext({ workerId: 'worker-b', now: new Date(clock), leaseMs: 300_000 });

  assert.equal(reclaimed, null);
  assert.equal(store.jobs[0].state, 'unknown');
  assert.equal(store.jobs[0].errorCode, 'PUBLISH_LEASE_EXPIRED_RECONCILE_REQUIRED');
  await assert.rejects(() => store.markPublished(leased, { providerAccountId: '101', providerPostId: 'stale' }), /PUBLISH_CLAIM_REQUIRED/);
});

test('expired current lease cannot publish but may be marked unknown', async () => {
  const context = baseContext();
  let clock = now.getTime();
  const store = createInMemoryMetaOrganicPublishStoreWithClock([context], () => clock);
  await store.enqueue(context.proposal);
  const leased = await store.claimNext({ workerId: 'worker-a', now, leaseMs: 300_000 });

  clock = now.getTime() + 301_000;
  await assert.rejects(() => store.markPublished(leased, { providerAccountId: '101', providerPostId: 'late' }), /PUBLISH_LEASE_EXPIRED/);
  await store.markUnknown(leased, 'OUTCOME_UNKNOWN', { provider: 'facebook', providerAccountId: '101', access_token: 'must-not-persist' });
  assert.equal(store.jobs[0].state, 'unknown');
  assert.equal('access_token' in store.jobs[0].receipts[context.proposal.accountConnectionId], false);
});

test('future scheduled jobs are not claimed or published early', async () => {
  const context = baseContext({ scheduledAt: '2026-10-12T04:00:00.000Z' });
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const calls = [];

  const early = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter(calls),
    now,
  });
  const due = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter(calls),
    now: new Date('2026-10-12T04:00:00.000Z'),
  });

  assert.equal(early.status, 'idle');
  assert.equal(due.status, 'published');
  assert.equal(calls.length, 1);
});

test('two Facebook Pages plus Instagram can publish on one campaign date as one distinct day', async () => {
  const contexts = [
    baseContext({ provider: 'facebook', accountConnectionId: 'facebook-page-1', draftId: 'fb-draft-1' }),
    baseContext({ provider: 'facebook', accountConnectionId: 'facebook-page-2', draftId: 'fb-draft-2' }),
    baseContext({ provider: 'instagram', accountConnectionId: 'instagram-account-1', draftId: 'ig-draft-1' }),
  ];
  const store = createInMemoryMetaOrganicPublishStore(contexts);
  for (const context of contexts) await store.enqueue(context.proposal);
  const calls = [];
  const config = { enabled: true, maxAttempts: 3, leaseMs: 300_000 };

  assert.equal((await processNextMetaOrganicPublishJob({ config, store, provider: providerAdapter(calls), now })).status, 'published');
  assert.equal((await processNextMetaOrganicPublishJob({ config, store, provider: providerAdapter(calls), now })).status, 'published');
  assert.equal((await processNextMetaOrganicPublishJob({ config, store, provider: providerAdapter(calls), now })).status, 'published');

  assert.deepEqual(calls.map((call) => call.provider), ['facebook', 'facebook', 'instagram']);
  assert.deepEqual(store.jobs.map((job) => job.state), ['published', 'published', 'published']);
  assert.ok(store.jobs.every((job) => job.receipts[job.accountConnectionId]?.status === 'published'));
});

test('cross-tenant jobs are blocked before provider calls', async () => {
  const context = baseContext({ draft: { userId: 'other-user' } });
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const calls = [];
  const result = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter(calls),
    now,
  });

  assert.deepEqual(calls, []);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'PUBLISH_TENANT_MISMATCH');
  assert.equal(store.jobs[0].state, 'blocked');
});

test('revoked account, changed asset and stale approval are rejected before provider calls', () => {
  const revoked = validateMetaOrganicPublishContext(baseContext({ account: { status: 'revoked' } }), now);
  const changedAsset = validateMetaOrganicPublishContext(baseContext({ asset: { manifestHash: 'new-hash' } }), now);
  const staleApproval = validateMetaOrganicPublishContext(baseContext({ approval: { contentVersion: 'old-content-version' } }), now);
  const missingExpiry = validateMetaOrganicPublishContext(baseContext({ account: { expiresAt: null } }), now);
  const invalidAccountId = validateMetaOrganicPublishContext(baseContext({ account: { providerAccountId: 'page-not-numeric' } }), now);

  assert.equal(revoked.reason, 'PUBLISH_CONNECTION_REQUIRED');
  assert.equal(changedAsset.reason, 'PUBLISH_ASSET_EXPORT_REQUIRED');
  assert.equal(staleApproval.reason, 'PUBLISH_APPROVAL_CHANGED');
  assert.equal(missingExpiry.reason, 'PUBLISH_CONNECTION_EXPIRED');
  assert.equal(invalidAccountId.reason, 'PUBLISH_ACCOUNT_CONTEXT_REQUIRED');
});

test('current discovery-only Instagram account contract is not publish-ready', () => {
  const validation = validateMetaOrganicPublishContext(baseContext({
    provider: 'instagram',
    account: {
      tokenKind: 'user',
      grantedScopes: ['instagram_basic', 'pages_show_list'],
    },
  }), now);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'PUBLISH_TOKEN_CONTRACT_REQUIRED');
});

test('distinct-day gate blocks a new publish date beyond active tier allowance', () => {
  const validation = validateMetaOrganicPublishContext(baseContext({
    campaignDate: '2026-10-31',
    existingCampaignDates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'],
  }), now);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'PUBLISH_DISTINCT_DAY_LIMIT');

  const sameCampaignDate = validateMetaOrganicPublishContext(baseContext({
    campaignDate: '2026-10-10',
    existingCampaignDates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'],
  }), now);
  assert.equal(sameCampaignDate.ok, true);
});

test('weekly distinct-day gate blocks new dates but allows same campaign date', () => {
  const blocked = validateMetaOrganicPublishContext(baseContext({
    campaignDate: '2026-10-07',
    existingCampaignDates: ['2026-10-05', '2026-10-06'],
  }), now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'PUBLISH_WEEKLY_DISTINCT_DAY_LIMIT');

  const sameDate = validateMetaOrganicPublishContext(baseContext({
    campaignDate: '2026-10-06',
    existingCampaignDates: ['2026-10-05', '2026-10-06'],
  }), now);
  assert.equal(sameDate.ok, true);
});

test('safe retryable failures back off and then exhaust without repeating unknown outcomes', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const calls = [];
  const config = { enabled: true, maxAttempts: 2, leaseMs: 300_000 };
  const provider = providerAdapter(calls, {
    facebook: async () => {
      throw new SafeRetryablePublishError('temporary provider outage', 'PROVIDER_5XX');
    },
  });

  const first = await processNextMetaOrganicPublishJob({ config, store, provider, now });
  assert.equal(first.status, 'retry');
  assert.equal(store.jobs[0].state, 'retry');
  assert.equal(store.jobs[0].attempts, 1);

  const second = await processNextMetaOrganicPublishJob({ config, store, provider, now: new Date(now.getTime() + 61_000) });
  assert.equal(second.status, 'failed');
  assert.equal(store.jobs[0].state, 'failed');
  assert.equal(store.jobs[0].attempts, 2);
  assert.equal(calls.length, 2);
});

test('timeout after provider success is marked unknown and is not blindly retried', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const calls = [];
  const config = { enabled: true, maxAttempts: 3, leaseMs: 300_000 };
  const provider = providerAdapter(calls, {
    facebook: async () => {
      throw new UnknownOutcomePublishError('socket timed out after provider accepted mutation', {
        provider: 'facebook',
        providerAccountId: '101',
        operation: 'page_photo_publish',
      });
    },
  });

  const first = await processNextMetaOrganicPublishJob({ config, store, provider, now });
  const second = await processNextMetaOrganicPublishJob({ config, store, provider, now: new Date(now.getTime() + 600_000) });

  assert.equal(first.status, 'unknown');
  assert.equal(second.status, 'idle');
  assert.equal(store.jobs[0].state, 'unknown');
  assert.equal(store.jobs[0].receipts[context.proposal.accountConnectionId].operation, 'page_photo_publish');
  assert.equal(calls.length, 1);
});

test('generic reset timeout or 5xx after dispatch is unknown, not automatic retry', async () => {
  for (const code of ['ECONNRESET', 'REQUEST_TIMEOUT', 'PROVIDER_5XX']) {
    const context = baseContext({ draftId: `ambiguous-${code}` });
    const store = createInMemoryMetaOrganicPublishStore([context]);
    await store.enqueue(context.proposal);
    const calls = [];
    const result = await processNextMetaOrganicPublishJob({
      config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
      store,
      provider: providerAdapter(calls, {
        facebook: async () => {
          throw Object.assign(new Error(code), { code });
        },
      }),
      now,
    });
    assert.equal(result.status, 'unknown');
    assert.equal(store.jobs[0].state, 'unknown');
    assert.equal(calls.length, 1);
  }
});

test('generic retryable flag without before-write proof is not retried', async () => {
  const context = baseContext({ draftId: 'generic-retryable' });
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const result = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter([], {
      facebook: async () => {
        throw Object.assign(new Error('generic retryable'), { retryable: true, code: 'PROVIDER_TEMPORARY' });
      },
    }),
    now,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(store.jobs[0].state, 'unknown');
});

test('provider success followed by persistence failure becomes unknown without retrying publish', async () => {
  const context = baseContext();
  const baseStore = createInMemoryMetaOrganicPublishStore([context]);
  await baseStore.enqueue(context.proposal);
  let publishMarkFailures = 0;
  const store = {
    ...baseStore,
    async markPublished() {
      publishMarkFailures += 1;
      throw Object.assign(new Error('fenced write failed'), { code: 'PERSISTENCE_WRITE_FAILED' });
    },
  };
  const calls = [];
  const result = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter(calls),
    now,
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'PUBLISH_PERSISTENCE_FAILED_AFTER_PROVIDER_SUCCESS');
  assert.equal(baseStore.jobs[0].state, 'unknown');
  assert.equal(calls.length, 1);
  assert.equal(publishMarkFailures, 1);
});

test('read-only reconciliation resolves timeout-after-success without another publish call', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const publishCalls = [];
  const config = { enabled: true, maxAttempts: 3, leaseMs: 300_000 };
  const provider = providerAdapter(publishCalls, {
    facebook: async () => {
      throw new UnknownOutcomePublishError('socket timed out after provider accepted mutation', {
        provider: 'facebook',
        providerAccountId: '101',
        dedupeKey: context.proposal.dedupeKey,
      });
    },
  });
  assert.equal((await processNextMetaOrganicPublishJob({ config, store, provider, now })).status, 'unknown');

  let lookupCalls = 0;
  const reconciled = await reconcileNextMetaOrganicPublishJob({
    config,
    store,
    provider: {
      async lookupPublishedMetaOrganicReceipt() {
        lookupCalls += 1;
        return {
          provider: 'facebook',
          providerAccountId: '101',
          providerPostId: 'fb-reconciled-1',
          dedupeKey: context.proposal.dedupeKey,
          permalink: 'https://www.facebook.com/fb-reconciled-1',
        };
      },
    },
    now: new Date(now.getTime() + 60_000),
  });
  const second = await reconcileNextMetaOrganicPublishJob({ config, store, provider: { lookupPublishedMetaOrganicReceipt: async () => assert.fail('already reconciled') }, now: new Date(now.getTime() + 120_000) });

  assert.equal(reconciled.status, 'reconciled');
  assert.equal(second.status, 'idle');
  assert.equal(store.jobs[0].state, 'published');
  assert.equal(store.jobs[0].receipts[context.proposal.accountConnectionId].status, 'reconciled');
  assert.equal(publishCalls.length, 1);
  assert.equal(lookupCalls, 1);
});

test('reconciliation rejects mismatched account or delivery proof and keeps unknown', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  await store.markUnknown(await store.claimNext({ workerId: 'worker-a', now, leaseMs: 300_000 }), 'OUTCOME_UNKNOWN', {
    provider: 'facebook',
    providerAccountId: '101',
    dedupeKey: context.proposal.dedupeKey,
  });

  const badAccount = await reconcileNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: { lookupPublishedMetaOrganicReceipt: async () => ({ provider: 'facebook', providerAccountId: '201', providerPostId: 'post-201', dedupeKey: context.proposal.dedupeKey }) },
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(badAccount.status, 'unknown');
  assert.equal(badAccount.reason, 'RECONCILE_PROOF_MISMATCH');
  assert.equal(store.jobs[0].state, 'unknown');

  const badDelivery = await reconcileNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: { lookupPublishedMetaOrganicReceipt: async () => ({ provider: 'facebook', providerAccountId: '101', providerPostId: 'post-1', dedupeKey: 'not-this-delivery' }) },
    now: new Date(now.getTime() + 120_000),
  });
  assert.equal(badDelivery.status, 'unknown');
  assert.equal(badDelivery.reason, 'RECONCILE_PROOF_MISMATCH');
  assert.equal(store.jobs[0].state, 'unknown');
});

test('inconclusive reconciliation stays unknown and concurrent reconciliation is fenced', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  await store.markUnknown(await store.claimNext({ workerId: 'worker-a', now, leaseMs: 300_000 }), 'OUTCOME_UNKNOWN', {
    provider: 'facebook',
    providerAccountId: '101',
    dedupeKey: context.proposal.dedupeKey,
  });

  const firstClaim = await store.claimUnknownForReconciliation({ workerId: 'reconcile-a', now: new Date(now.getTime() + 60_000), leaseMs: 300_000 });
  assert.equal(await store.claimUnknownForReconciliation({ workerId: 'reconcile-b', now: new Date(now.getTime() + 61_000), leaseMs: 300_000 }), null);
  await store.keepUnknown(firstClaim, 'RECONCILE_INCONCLUSIVE', { status: 'not_found' });
  assert.equal(store.jobs[0].state, 'unknown');

  const result = await reconcileNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: { lookupPublishedMetaOrganicReceipt: async () => null },
    now: new Date(now.getTime() + 120_000),
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'RECONCILE_INCONCLUSIVE');
  assert.equal(store.jobs[0].state, 'unknown');
});

test('malformed or identity-overriding provider acknowledgements become unknown, not published', async () => {
  const context = baseContext();
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);
  const calls = [];
  const result = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter(calls, { facebook: async () => ({}) }),
    now,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(store.jobs[0].state, 'unknown');
  assert.equal(calls.length, 1);

  const overrideContext = baseContext({ draftId: 'fb-draft-override' });
  const overrideStore = createInMemoryMetaOrganicPublishStore([overrideContext]);
  await overrideStore.enqueue(overrideContext.proposal);
  await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store: overrideStore,
    provider: providerAdapter([], {
      facebook: async () => ({
        provider: 'instagram',
        providerAccountId: '999999999',
        providerPostId: 'fb-post-1',
        access_token: 'must-not-persist',
      }),
    }),
    now,
  });
  assert.equal(overrideStore.jobs[0].state, 'unknown');
  const unknownReceipt = overrideStore.jobs[0].receipts[overrideContext.proposal.accountConnectionId];
  assert.equal(unknownReceipt.reason, 'AMBIGUOUS_PROVIDER_RECEIPT');
  assert.equal('access_token' in unknownReceipt, false);
});

test('safe provider receipts are allowlisted and cannot persist arbitrary token fields', async () => {
  const context = baseContext({ draftId: 'receipt-draft' });
  const store = createInMemoryMetaOrganicPublishStore([context]);
  await store.enqueue(context.proposal);

  const result = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter([], {
      facebook: async () => ({
        provider: 'facebook',
        providerAccountId: '101',
        providerPostId: '1234567890_0987654321',
        permalink: 'https://www.facebook.com/1234567890_0987654321',
        access_token: 'secret',
        status: 'failed',
      }),
    }),
    now,
  });

  const receipt = store.jobs[0].receipts[context.proposal.accountConnectionId];
  assert.equal(result.status, 'published');
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.provider, 'facebook');
  assert.equal(receipt.providerAccountId, '101');
  assert.equal(receipt.providerPostId, '1234567890_0987654321');
  assert.equal('access_token' in receipt, false);
});

test('loaded context must match the claimed job before provider dispatch', async () => {
  const jobContext = baseContext({ draftId: 'job-a' });
  const contextB = baseContext({ draftId: 'job-b' });
  const store = createInMemoryMetaOrganicPublishStore([jobContext]);
  await store.enqueue(jobContext.proposal);
  store.contextByDedupe.set(jobContext.proposal.dedupeKey, contextB);
  const calls = [];

  const result = await processNextMetaOrganicPublishJob({
    config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 },
    store,
    provider: providerAdapter(calls),
    now,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'PUBLISH_CONTEXT_MISMATCH');
  assert.equal(store.jobs[0].state, 'blocked');
  assert.deepEqual(calls, []);
});

test('publisher foundation exposes explicit proposed contract metadata only', () => {
  assert.equal(META_ORGANIC_PUBLISHER_CONTRACT_VERSION, 'meta_organic_publisher_pilot_v1');
  assert.equal(META_ORGANIC_PUBLISHER_PROVENANCE, 'meta_organic_publisher_foundation_2026_10_12');
  assert.deepEqual(META_ORGANIC_PUBLISH_PERMISSIONS.facebook, ['pages_manage_posts', 'pages_read_engagement']);
  assert.deepEqual(META_ORGANIC_PUBLISH_PERMISSIONS.instagram, ['instagram_basic', 'instagram_content_publish', 'pages_read_engagement']);
  assert.equal(META_ORGANIC_TOKEN_KINDS.facebook, 'page');
  assert.equal(META_ORGANIC_TOKEN_KINDS.instagram, 'page');
});


test('unexpected errors after a mock provider write stay unknown and are never resent', async () => {
  for (const error of [new Error('unexpected response'), new SyntaxError('invalid provider response JSON'), Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' })]) {
    const context = baseContext();
    const store = createInMemoryMetaOrganicPublishStore([context]);
    await store.enqueue(context.proposal);
    let writes = 0;
    const provider = providerAdapter([], { facebook: async () => { writes += 1; throw error; } });
    const options = { config: { enabled: true, maxAttempts: 3, leaseMs: 300_000 }, store, provider, now };
    const result = await processNextMetaOrganicPublishJob(options);
    assert.equal(result.status, 'unknown');
    assert.equal(store.jobs[0].state, 'unknown');
    assert.equal((await processNextMetaOrganicPublishJob(options)).status, 'idle');
    assert.equal(writes, 1);
    const reconciled = await reconcileNextMetaOrganicPublishJob({
      ...options,
      provider: { lookupPublishedMetaOrganicReceipt: async () => ({
        status: 'found', provider: 'facebook', providerAccountId: context.account.providerAccountId,
        providerPostId: 'synthetic-published-post', dedupeKey: context.proposal.dedupeKey,
      }) },
    });
    assert.equal(reconciled.status, 'reconciled');
    assert.equal(writes, 1);
  }
});
