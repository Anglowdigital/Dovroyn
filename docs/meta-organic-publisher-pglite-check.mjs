import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildMetaOrganicPublishProposal,
  createRpcMetaOrganicPublishStore,
  processNextMetaOrganicPublishJob,
  reconcileNextMetaOrganicPublishJob,
} from '../api/_lib/metaOrganicPublisher.js';

const pgliteModule = process.env.PGLITE_MODULE;
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
});

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function literalJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function proposal(overrides = {}) {
  const body = overrides.body || 'Approved synthetic caption';
  return buildMetaOrganicPublishProposal({
    provider: 'facebook',
    userId: ids.user,
    podId: ids.pod,
    draftId: ids.draft,
    accountConnectionId: ids.account,
    contentVersion: crypto.createHash('md5').update(body).digest('hex'),
    assetManifestHash: crypto.createHash('sha256').update('asset-v1').digest('hex'),
    approvalId: ids.approval,
    campaignDate: '2026-10-12',
    ...overrides,
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
    INSERT INTO private.meta_organic_credentials (
      connection_id, token_kind, encrypted_access_token, encryption_key_version
    ) VALUES (
      '${ids.account}', 'page', 'syntheticEncryptedAccessTokenValue_000000000000', 'test-v1'
    );
    INSERT INTO public.social_posts (
      id, pod_id, platform, body, status, scheduled_at, generation_date
    ) VALUES (
      '${ids.draft}', '${ids.pod}', 'facebook', 'Approved synthetic caption',
      'scheduled', '2098-10-12T03:00:00Z', '2026-10-12'
    );
  `);
  return db;
}

async function seedApprovalAndExport(db, p = proposal()) {
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
      manifest_hash, user_id, pod_id, draft_id, media_type, byte_length,
      provider_readable_url, object_version, immutable, status, exported_at
    ) VALUES (
      '${p.assetManifestHash}', '${p.userId}', '${p.podId}', '${p.draftId}',
      'image/jpeg', 1000, 'https://cdn.example.test/export.jpg', 'object-v1',
      true, 'exported', '2026-10-11T00:00:00Z'
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
    };
    if (!argsByName[name]) throw new Error(`Unhandled RPC ${name}`);
    try {
      const result = await db.query(`SELECT public.${name}(${argsByName[name].map(sqlValue).join(', ')}) AS result`);
      return result.rows[0].result;
    } catch (error) {
      const message = error?.message || String(error);
      const known = message.match(/PUBLISH_[A-Z_]+/)?.[0];
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
      has_function_privilege('authenticated', 'private.meta_organic_require_lease(uuid,text,text,boolean)', 'EXECUTE') AS can_require_lease,
      has_schema_privilege('authenticated', 'private', 'USAGE') AS can_use_private_schema,
      has_table_privilege('authenticated', 'private.meta_organic_publish_jobs', 'SELECT') AS can_read_jobs
  `);
  assert.equal(privileges.rows[0].can_claim, false);
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
await checkLeaseAndPrivilegeFences();
await checkUnknownTransition();
await checkReapprovalDedupe();
await checkAllowanceWindowRolloverAndReservations();
await checkRpcWorkerSuccessAndChangedDraftBlock();
await checkRpcReconciliationSuccess();
console.log('meta organic publisher proposed SQL PGlite checks passed');
