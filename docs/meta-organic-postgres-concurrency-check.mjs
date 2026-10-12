#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const runtimePath = process.env.POSTGRES_ACCEPTANCE_RUNTIME_JSON || '/tmp/dovroyn-pg-acceptance-runtime/runtime.json';
const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
const psqlBin = path.join(runtime.bin, 'psql');
const createdbBin = path.join(runtime.bin, 'createdb');
const dropdbBin = path.join(runtime.bin, 'dropdb');
const testDb = process.env.POSTGRES_ACCEPTANCE_DB || 'dovroyn_acceptance';
const keepDb = process.env.POSTGRES_ACCEPTANCE_KEEP_DB === 'true';
const connectionSqlPath = new URL('../supabase/proposed-migrations/20261012000000_proposed_meta_organic_connection_cutover.sql', import.meta.url);
const publisherSqlPath = new URL('../supabase/proposed-migrations/20261012003000_proposed_meta_organic_publisher_pilot.sql', import.meta.url);

const ids = Object.freeze({
  user: '00000000-0000-4000-8000-000000000001',
  pod: '00000000-0000-4000-8000-000000000002',
  draft: '00000000-0000-4000-8000-000000000003',
  account1: '00000000-0000-4000-8000-000000000006',
  creativeApproval: '00000000-0000-4000-8000-000000000007',
  account2: '00000000-0000-4000-8000-000000000008',
  calendarItem: '00000000-0000-4000-8000-000000000009',
});

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function approvalIdFor(entry, suffix = '') {
  const digest = crypto.createHash('sha256')
    .update(`${entry.calendarItemId}:${entry.accountConnectionId}:${entry.assetManifestHash}:${suffix}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonSql(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function envFor(db = 'postgres') {
  return {
    ...process.env,
    LD_LIBRARY_PATH: runtime.lib,
    PGHOST: runtime.socket,
    PGPORT: String(runtime.port),
    PGUSER: runtime.role,
    PGDATABASE: db,
  };
}

function command(bin, args, { db = 'postgres', input = '', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: envFor(db),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const error = new Error(`Timed out running ${path.basename(bin)} ${args.join(' ')}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(stderr || stdout || `${path.basename(bin)} exited ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.end(input);
  });
}

function psql(db, sql, options = {}) {
  return command(psqlBin, ['--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'], {
    db,
    input: sql,
    timeoutMs: options.timeoutMs || 30_000,
  });
}

function psqlFile(db, file) {
  return command(psqlBin, ['--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--file', file.pathname], {
    db,
    timeoutMs: 60_000,
  });
}

async function psqlJson(db, sql, options = {}) {
  const result = await psql(db, sql, options);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!line) return null;
  return JSON.parse(line);
}

async function psqlExpectError(db, sql, pattern, label, options = {}) {
  try {
    await psql(db, sql, options);
  } catch (error) {
    const text = `${error.stderr}\n${error.stdout}\n${error.message}`;
    if (pattern.test(text)) return error;
    throw new Error(`${label} failed with unexpected error:\n${text}`);
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function recreateDatabase() {
  await command(dropdbBin, ['--if-exists', '--force', testDb], { timeoutMs: 30_000 }).catch(async () => {
    await psql('postgres', `DROP DATABASE IF EXISTS ${testDb} WITH (FORCE);`, { timeoutMs: 30_000 });
  });
  await command(createdbBin, [testDb], { timeoutMs: 30_000 });
}

async function setupSchema() {
  await psql(testDb, `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS private;
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
    CREATE TABLE public.pod_preferences (
      id UUID PRIMARY KEY,
      pod_id UUID NOT NULL REFERENCES public.pods(id),
      preference_type TEXT NOT NULL,
      preference_value JSONB NOT NULL,
      source TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.pod_assets (
      id UUID PRIMARY KEY,
      pod_id UUID NOT NULL REFERENCES public.pods(id),
      storage_path TEXT NOT NULL,
      file_name TEXT,
      media_type TEXT,
      file_size BIGINT,
      asset_role TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE public.calendar_items (
      id UUID PRIMARY KEY,
      pod_id UUID NOT NULL REFERENCES public.pods(id),
      scheduled_date DATE NOT NULL,
      platform TEXT NOT NULL,
      caption TEXT NOT NULL,
      creative_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await psqlFile(testDb, connectionSqlPath);
  await psqlFile(testDb, publisherSqlPath);
}

function metadata({ podId, draftId, provider = 'facebook', caption, targetConnectionIds = [ids.account1, ids.account2] }) {
  return {
    kind: 'dovroyn_calendar_metadata',
    version: 1,
    creative: {
      kind: 'dovroyn_calendar_creative',
      version: 1,
      pod_id: podId,
      post_id: draftId,
      platform: provider,
      headline: 'Synthetic approved headline',
      call_to_action: 'Learn more',
      content_snapshot: caption,
      approved_at: '2026-10-11T00:00:00Z',
      image: { kind: 'upload', storage_path: `${ids.user}/${podId}/synthetic-source.jpg` },
    },
    targets: targetConnectionIds.map((connectionId, index) => ({
      provider,
      providerAccountId: providerAccountIdForConnection(connectionId, index),
      accountConnectionId: connectionId,
      accountLabel: `Page ${providerAccountIdForConnection(connectionId, index)}`,
    })),
  };
}

function providerAccountIdForConnection(connectionId, index = 0) {
  const providerIds = new Map([
    [ids.account1, '101'],
    [ids.account2, '201'],
    [uuid(106), '301'],
    [uuid(107), '401'],
    [uuid(108), '501'],
    [uuid(109), '601'],
  ]);
  return providerIds.get(connectionId) || String(700 + index);
}

async function seedBaseRows() {
  await psql(testDb, `
    INSERT INTO auth.users (id) VALUES ('${ids.user}');
    INSERT INTO public.subscriptions (user_id, tier, status, current_period_end, subscription_started_at, created_at)
    VALUES ('${ids.user}', 'starter', 'active', '2099-01-01T00:00:00Z', '2098-10-01T00:00:00Z', '2098-10-01T00:00:00Z');
  `);
  await seedPodStack({
    podId: ids.pod,
    draftId: ids.draft,
    calendarItemId: ids.calendarItem,
    calendarDate: '2098-10-12',
    caption: 'Approved synthetic caption',
    accountIds: [ids.account1, ids.account2],
  });
}

async function seedPodStack({ podId, draftId, calendarItemId, calendarDate, caption, accountIds, createdAt = '2026-10-11T00:00:00Z' }) {
  await psql(testDb, `
    INSERT INTO public.pods (id, user_id, accepted_strategy, status)
    VALUES ('${podId}', '${ids.user}', 'Approved synthetic pod strategy', 'direction_locked')
    ON CONFLICT (id) DO UPDATE SET accepted_strategy = EXCLUDED.accepted_strategy, status = EXCLUDED.status;
    INSERT INTO public.social_posts (id, pod_id, platform, body, status, scheduled_at, generation_date)
    VALUES ('${draftId}', '${podId}', 'facebook', ${sqlString(caption)}, 'scheduled', '${calendarDate}T12:01:00Z', '2026-10-12')
    ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, status = EXCLUDED.status;
    INSERT INTO public.pod_preferences (id, pod_id, preference_type, preference_value, source, active, created_at)
    VALUES (
      '${creativeApprovalForDraft(draftId)}', '${podId}', 'creative_review',
      ${jsonSql({
        post_id: draftId,
        headline: 'Synthetic approved headline',
        call_to_action: 'Learn more',
        content_snapshot: caption,
        status: 'approved',
        approved_at: '2026-10-11T00:00:00Z',
        image: { kind: 'upload', storage_path: `${ids.user}/${podId}/synthetic-source.jpg` },
        composition: {
          version: 'meta_organic_creative_composition_v2',
          layout: 'meta-organic-portrait-v1',
          font_contract: 'system-ui-safe-v1',
          brand_name: 'Synthetic Pod',
          image_role: 'image',
          typography_only: false,
          headline: 'Synthetic approved headline',
          call_to_action: 'Learn more',
        },
        final_render_evidence: { hash: hash(`render:${draftId}`), mediaType: 'image/jpeg', byteLength: 1000 },
      })},
      'user_override', true, '${createdAt}'
    )
    ON CONFLICT (id) DO UPDATE SET preference_value = EXCLUDED.preference_value, active = true;
    INSERT INTO public.calendar_items (id, pod_id, scheduled_date, platform, caption, creative_note, created_at)
    VALUES (
      '${calendarItemId}', '${podId}', '${calendarDate}', 'facebook', ${sqlString(caption)},
      ${sqlString(JSON.stringify(metadata({ podId, draftId, caption, targetConnectionIds: accountIds })))},
      '${createdAt}'
    )
    ON CONFLICT (id) DO UPDATE SET scheduled_date = EXCLUDED.scheduled_date, caption = EXCLUDED.caption, creative_note = EXCLUDED.creative_note;
  `);
  for (const [index, accountId] of accountIds.entries()) {
    const providerAccountId = providerAccountIdForConnection(accountId, index);
    await psql(testDb, `
      INSERT INTO private.meta_organic_connections (
        id, user_id, pod_id, provider, provider_account_id, account_label, status, granted_scopes, expires_at
      ) VALUES (
        '${accountId}', '${ids.user}', '${podId}', 'facebook', '${providerAccountId}', 'Page ${providerAccountId}',
        'connected', ARRAY['pages_manage_posts','pages_read_engagement','pages_show_list'], '2099-01-01T00:00:00Z'
      )
      ON CONFLICT (id) DO UPDATE SET pod_id = EXCLUDED.pod_id, provider_account_id = EXCLUDED.provider_account_id, status = 'connected';
      INSERT INTO private.meta_organic_credentials (connection_id, token_kind, encrypted_access_token, encryption_key_version)
      VALUES ('${accountId}', 'page', 'syntheticEncryptedAccessTokenValue_${String(index).padStart(24, '0')}', 'test-v1')
      ON CONFLICT (connection_id) DO UPDATE SET encrypted_access_token = EXCLUDED.encrypted_access_token;
    `);
    await seedExport({ podId, draftId, accountId, providerAccountId, caption });
  }
}

function creativeApprovalForDraft(draftId) {
  if (draftId === ids.draft) return ids.creativeApproval;
  return approvalIdFor({ calendarItemId: draftId, accountConnectionId: ids.account1, assetManifestHash: hash(`creative:${draftId}`) }, 'creative');
}

async function seedExport({ podId, draftId, accountId, providerAccountId, caption }) {
  const contentVersion = md5(caption);
  const manifestHash = hash(`manifest:${podId}:${draftId}:${accountId}:${contentVersion}`);
  const outputHash = hash(`output:${manifestHash}`);
  const objectPath = `meta-organic-exports/${ids.user}/${podId}/${draftId}/${creativeApprovalForDraft(draftId)}/${accountId}/${outputHash}.jpg`;
  const manifest = {
    contractVersion: 'meta_organic_artwork_export_v1',
    status: 'exported',
    immutable: true,
    manifestHash,
    authority: {
      userId: ids.user,
      podId,
      postId: draftId,
      provider: 'facebook',
      accountConnectionId: accountId,
      providerAccountId,
      creativeApprovalId: creativeApprovalForDraft(draftId),
      contentVersion,
    },
    output: {
      hash: outputHash,
      providerReadableUrl: `https://cdn.example.test/${manifestHash}.jpg`,
      objectPath,
    },
  };
  await psql(testDb, `
    INSERT INTO private.meta_organic_publish_exports (
      manifest_hash, user_id, pod_id, draft_id, account_connection_id, media_type,
      byte_length, output_hash, provider_readable_url, provider_readable_url_expires_at,
      object_version, manifest, immutable, status, exported_at
    ) VALUES (
      '${manifestHash}', '${ids.user}', '${podId}', '${draftId}', '${accountId}', 'image/jpeg',
      1000, '${outputHash}', 'https://cdn.example.test/${manifestHash}.jpg', '2099-01-01T00:00:00Z',
      '${objectPath}', ${jsonSql(manifest)}, true, 'exported', '2026-10-11T00:00:00Z'
    )
    ON CONFLICT (manifest_hash) DO UPDATE SET manifest = EXCLUDED.manifest, provider_readable_url = EXCLUDED.provider_readable_url;
  `);
}

async function prepareRequest(podId = ids.pod, date = '2098-10-12', suffix = '') {
  const prepared = await psqlJson(testDb, `
    SELECT public.prepare_meta_organic_calendar_publish_review('${ids.user}', '${podId}', '${date}'::date)::text;
  `);
  const approvals = prepared.entries.map((entry) => ({
    id: approvalIdFor(entry, suffix),
    userId: prepared.userId,
    podId: prepared.podId,
    provider: entry.provider,
    draftId: entry.draftId,
    accountConnectionId: entry.accountConnectionId,
    contentVersion: entry.contentVersion,
    assetManifestHash: entry.assetManifestHash,
    campaignDate: prepared.scheduledDate,
    scheduledAt: prepared.scheduledAt,
    timezone: prepared.timezone,
    calendarItemId: entry.calendarItemId,
    calendarSnapshotHash: entry.calendarSnapshotHash,
    calendarDaySnapshotHash: prepared.calendarDaySnapshotHash,
    contextFingerprint: '',
    status: 'approved',
    approvedAt: '2026-10-12T00:00:00.000Z',
    approvedBy: prepared.userId,
  }));
  return {
    userId: prepared.userId,
    podId: prepared.podId,
    campaignDate: prepared.scheduledDate,
    scheduledAt: prepared.scheduledAt,
    timezone: prepared.timezone,
    calendarDaySnapshotHash: prepared.calendarDaySnapshotHash,
    contextFingerprint: '',
    approvals,
  };
}

async function confirm(request) {
  return psqlJson(testDb, `
    SELECT public.confirm_meta_organic_calendar_publish_review(${jsonSql(request)})::text;
  `, { timeoutMs: 20_000 });
}

async function waitForPgSleep(applicationName, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await psqlJson(testDb, `
      SELECT jsonb_build_object(
        'count', count(*),
        'events', coalesce(jsonb_agg(jsonb_build_object('state', state, 'waitEvent', wait_event)), '[]'::jsonb)
      )::text
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${sqlString(applicationName)}
        AND wait_event = 'PgSleep';
    `);
    if (Number(state?.count || 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${applicationName} to enter pg_sleep.`);
}

async function checkDoubleConfirmation() {
  const request = await prepareRequest(ids.pod, '2098-10-12', 'double');
  const [a, b] = await Promise.allSettled([confirm(request), confirm(request)]);
  assert.equal(a.status, 'fulfilled', a.reason?.message);
  assert.equal(b.status, 'fulfilled', b.reason?.message);
  const count = await psqlJson(testDb, `
    SELECT jsonb_build_object(
      'jobs', (SELECT count(*) FROM private.meta_organic_publish_jobs WHERE pod_id = '${ids.pod}'),
      'approvals', (SELECT count(*) FROM private.meta_organic_publish_approvals WHERE pod_id = '${ids.pod}')
    )::text;
  `);
  assert.deepEqual(count, { jobs: 2, approvals: 2 });
}

async function checkAtomicRollback() {
  await psql(testDb, `DELETE FROM private.meta_organic_publish_jobs; DELETE FROM private.meta_organic_publish_approvals;`);
  const request = await prepareRequest(ids.pod, '2098-10-12', 'rollback');
  request.approvals[1].assetManifestHash = hash('missing-export-for-second-account');
  await psqlExpectError(
    testDb,
    `SELECT public.confirm_meta_organic_calendar_publish_review(${jsonSql(request)});`,
    /PUBLISH_REVIEW_CONTEXT_CHANGED|PUBLISH_EXPORT_CONTEXT_REQUIRED/,
    'later-account rollback',
  );
  const count = await psqlJson(testDb, `
    SELECT jsonb_build_object(
      'jobs', (SELECT count(*) FROM private.meta_organic_publish_jobs),
      'approvals', (SELECT count(*) FROM private.meta_organic_publish_approvals)
    )::text;
  `);
  assert.deepEqual(count, { jobs: 0, approvals: 0 });
}

async function checkCalendarEditLocks() {
  await psql(testDb, `DELETE FROM private.meta_organic_publish_jobs; DELETE FROM private.meta_organic_publish_approvals;`);
  await psql(testDb, `
    INSERT INTO public.calendar_items (id, pod_id, scheduled_date, platform, caption, creative_note, created_at)
    VALUES ('${uuid(900)}', '${ids.pod}', '2098-10-11', 'facebook', 'moved in', '{}', '2026-10-10T00:00:00Z')
    ON CONFLICT (id) DO UPDATE SET scheduled_date = EXCLUDED.scheduled_date, caption = EXCLUDED.caption, creative_note = EXCLUDED.creative_note;
  `);
  const request = await prepareRequest(ids.pod, '2098-10-12', 'lock-holder');
  const applicationName = `dovroyn-confirm-lock-${Date.now()}`;
  const hold = psql(testDb, `
    SET application_name = ${sqlString(applicationName)};
    BEGIN;
    SELECT public.confirm_meta_organic_calendar_publish_review(${jsonSql(request)});
    SELECT pg_sleep(3);
    COMMIT;
  `, { timeoutMs: 12_000 });
  await waitForPgSleep(applicationName);
  await psqlExpectError(
    testDb,
    `
      SET lock_timeout = '500ms';
      UPDATE public.calendar_items SET caption = caption || ' changed' WHERE id = '${ids.calendarItem}';
    `,
    /lock timeout|canceling statement due to lock timeout/i,
    'caption edit blocked by reviewed-day transaction lock',
  );
  await psqlExpectError(
    testDb,
    `
      SET lock_timeout = '500ms';
      UPDATE public.calendar_items SET scheduled_date = '2098-10-12' WHERE id = '${uuid(900)}';
    `,
    /lock timeout|canceling statement due to lock timeout/i,
    'moved-in row blocked by reviewed-day transaction table lock',
  );
  await hold;
}

async function checkOwnerWeeklyLastSlotAcrossPods() {
  await psql(testDb, `DELETE FROM private.meta_organic_publish_jobs; DELETE FROM private.meta_organic_publish_approvals;`);
  const podA = uuid(101);
  const podB = uuid(102);
  await seedPodStack({
    podId: podA,
    draftId: uuid(111),
    calendarItemId: uuid(121),
    calendarDate: '2098-10-14',
    caption: 'Pod A approved caption',
    accountIds: [uuid(106)],
  });
  await seedPodStack({
    podId: podB,
    draftId: uuid(112),
    calendarItemId: uuid(122),
    calendarDate: '2098-10-15',
    caption: 'Pod B approved caption',
    accountIds: [uuid(107)],
  });
  await seedPodStack({
    podId: uuid(103),
    draftId: uuid(113),
    calendarItemId: uuid(123),
    calendarDate: '2098-10-13',
    caption: 'Existing weekly slot caption',
    accountIds: [uuid(108)],
  });
  const existing = await prepareRequest(uuid(103), '2098-10-13', 'existing-slot');
  await confirm(existing);

  const requestA = await prepareRequest(podA, '2098-10-14', 'weekly-a');
  const requestB = await prepareRequest(podB, '2098-10-15', 'weekly-b');
  const results = await Promise.allSettled([confirm(requestA), confirm(requestB)]);
  const successes = results.filter((result) => result.status === 'fulfilled');
  const failures = results.filter((result) => result.status === 'rejected');
  assert.equal(successes.length, 1, JSON.stringify(results));
  assert.equal(failures.length, 1, JSON.stringify(results));
  assert.match(`${failures[0].reason.stderr}\n${failures[0].reason.message}`, /PUBLISH_WEEKLY_DISTINCT_DAY_LIMIT/);
  const dates = await psqlJson(testDb, `
    SELECT jsonb_agg(DISTINCT campaign_date ORDER BY campaign_date)::text
    FROM private.meta_organic_publish_jobs
    WHERE user_id = '${ids.user}' AND state NOT IN ('failed','blocked');
  `);
  assert.equal(dates.length, 2, 'starter weekly limit should retain exactly two distinct owner dates');
}

async function checkWorkerClaimFencing() {
  await psql(testDb, `DELETE FROM private.meta_organic_publish_jobs; DELETE FROM private.meta_organic_publish_approvals;`);
  const request = await prepareRequest(ids.pod, '2098-10-12', 'worker');
  await confirm(request);
  const noneTooEarly = await psqlJson(testDb, `
    SELECT public.claim_meta_organic_publish_job('early-worker', '2098-10-12T11:59:00Z', 30000)::text;
  `);
  assert.equal(noneTooEarly, null);
  const claim = await psqlJson(testDb, `
    SELECT public.claim_meta_organic_publish_job('worker-a', '2098-10-12T12:00:00Z', 30000)::text;
  `);
  assert.ok(claim?.id, 'expected due job claim');
  const second = await psqlJson(testDb, `
    SELECT public.claim_meta_organic_publish_job('worker-b', '2098-10-12T12:00:01Z', 30000)::text;
  `);
  assert.ok(second?.id, 'second account should still be claimable');
  await psqlExpectError(
    testDb,
    `SELECT public.get_meta_organic_publish_context('${claim.id}', 'worker-a', 'wrong-token');`,
    /PUBLISH_LEASE_REQUIRED/,
    'wrong operation token cannot read context',
  );
  await psqlExpectError(
    testDb,
    `SELECT public.assert_meta_organic_publish_mutation_lease('${claim.id}', 'worker-b', '${claim.operationToken}', 'facebook_photo_before_write');`,
    /PUBLISH_LEASE_REQUIRED/,
    'wrong worker cannot fence mutation',
  );
  const stage = await psqlJson(testDb, `
    SELECT public.assert_meta_organic_publish_mutation_lease('${claim.id}', 'worker-a', '${claim.operationToken}', 'facebook_photo_before_write')::text;
  `);
  assert.equal(stage.ok, true);
  await psqlExpectError(
    testDb,
    `SELECT public.assert_meta_organic_publish_mutation_lease('${claim.id}', 'worker-a', '${claim.operationToken}', 'facebook_photo_before_write');`,
    /PUBLISH_STAGE_ALREADY_DISPATCHED/,
    'double mutation fence rejected',
  );
  await psql(testDb, `UPDATE private.meta_organic_publish_jobs SET lease_expires_at = '2098-10-12T12:00:02Z' WHERE id = '${claim.id}';`);
  const expired = await psqlJson(testDb, `
    SELECT public.claim_meta_organic_publish_job('expiry-worker', '2098-10-12T12:00:03Z', 30000)::text;
  `);
  assert.equal(expired, null);
  const state = await psqlJson(testDb, `
    SELECT jsonb_build_object('state', state, 'error', error_code) FROM private.meta_organic_publish_jobs WHERE id = '${claim.id}';
  `);
  assert.equal(state.state, 'unknown');
  assert.equal(state.error, 'PUBLISH_LEASE_EXPIRED_RECONCILE_REQUIRED');
}

async function checkCalendarContextEdits() {
  await psql(testDb, `DELETE FROM private.meta_organic_publish_jobs; DELETE FROM private.meta_organic_publish_approvals;`);
  const request = await prepareRequest(ids.pod, '2098-10-12', 'stale');
  await psql(testDb, `UPDATE public.calendar_items SET caption = 'Edited after prepare' WHERE id = '${ids.calendarItem}';`);
  await psqlExpectError(
    testDb,
    `SELECT public.confirm_meta_organic_calendar_publish_review(${jsonSql(request)});`,
    /PUBLISH_CALENDAR_CONTEXT_CHANGED/,
    'caption edit invalidates prepared review',
  );
  await psql(testDb, `UPDATE public.calendar_items SET caption = 'Approved synthetic caption' WHERE id = '${ids.calendarItem}';`);
  const changedTargets = await prepareRequest(ids.pod, '2098-10-12', 'target-start');
  const note = metadata({ podId: ids.pod, draftId: ids.draft, caption: 'Approved synthetic caption', targetConnectionIds: [ids.account1] });
  await psql(testDb, `UPDATE public.calendar_items SET creative_note = ${sqlString(JSON.stringify(note))} WHERE id = '${ids.calendarItem}';`);
  await psqlExpectError(
    testDb,
    `SELECT public.confirm_meta_organic_calendar_publish_review(${jsonSql(changedTargets)});`,
    /PUBLISH_CALENDAR_CONTEXT_CHANGED/,
    'target edit invalidates prepared review',
  );
  await psql(testDb, `UPDATE public.calendar_items SET creative_note = ${sqlString(JSON.stringify(metadata({ podId: ids.pod, draftId: ids.draft, caption: 'Approved synthetic caption', targetConnectionIds: [ids.account1, ids.account2] })))} WHERE id = '${ids.calendarItem}';`);
}

async function run() {
  console.log(`Using PostgreSQL ${runtime.socket}:${runtime.port} as role ${runtime.role}; creating disposable DB ${testDb}.`);
  await recreateDatabase();
  try {
    await setupSchema();
    await seedBaseRows();
    await checkDoubleConfirmation();
    await checkAtomicRollback();
    await checkCalendarContextEdits();
    await checkCalendarEditLocks();
    await checkOwnerWeeklyLastSlotAcrossPods();
    await checkWorkerClaimFencing();
    console.log('Real PostgreSQL multi-session acceptance harness passed.');
    console.log('Covered: double confirmation, owner weekly last-slot serialization across pods, atomic second-account rollback, calendar caption/target/date edit invalidation, moved-in-row lock, and worker claim fencing.');
    console.log('This uses a disposable local DB only; no live SQL, credentials, storage, Graph calls, scheduler activation, posting, or spend.');
  } finally {
    if (!keepDb) {
      await command(dropdbBin, ['--if-exists', '--force', testDb], { timeoutMs: 30_000 }).catch(() => {});
    }
  }
}

run().catch((error) => {
  console.error(error?.stderr || error?.message || error);
  process.exit(1);
});
