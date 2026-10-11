import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import connectHandler from '../api/integrations/meta/connect.js';
import {
  assertMetaOrganicReady,
  authorizeMetaConnection,
  buildIntegrationRedirect,
  buildMetaAuthorizeUrl,
  buildOAuthCookie,
  clearOAuthCookie,
  completeMetaCallback,
  createStateRecord,
  encryptProviderToken,
  getMetaOrganicConfig,
  hashIncomingState,
  loadInstagramAccount,
  loadMetaOrganicReadiness,
  META_OAUTH_COOKIE,
  META_ORGANIC_SCOPES,
  normalizeConnection,
  validateGrantedScopes,
  validateOAuthCookie,
} from '../api/_lib/metaOrganic.js';

const activePaidSubscription = Object.freeze({
  tier: 'starter',
  status: 'active',
  current_period_end: '2099-01-01T00:00:00.000Z',
});

const encryptionKeyBytes = Buffer.from('0123456789abcdef0123456789abcdef');
const config = Object.freeze({
  appId: '1335715488316611',
  appSecret: 'mock-app-secret',
  redirectUri: 'https://dovroyn.com/api/integrations/callback',
  graphVersion: 'v26.0',
  encryptionKey: encryptionKeyBytes.toString('base64url'),
  encryptionKeyVersion: 'test-v1',
  cookieSecret: 'mock-cookie-secret',
  activationEnabled: true,
  configured: true,
  scopes: [...META_ORGANIC_SCOPES],
  contractVersion: 'meta_organic_facebook_login_v1',
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function mockFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const next = responses.shift();
      if (!next) throw new Error('Unexpected provider call');
      return jsonResponse(next.payload, next.status || 200);
    },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function stateRecord(now = Date.now()) {
  let index = 0;
  const tokens = ['A'.repeat(43), 'B'.repeat(43)];
  return createStateRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    redirectUri: config.redirectUri,
    now,
    random: () => tokens[index++],
  });
}

test('Meta authorization URL uses Facebook Login with least-privilege organic scopes', () => {
  const url = new URL(buildMetaAuthorizeUrl(config, 'state_123456789012345678901234567890'));
  assert.equal(url.hostname, 'www.facebook.com');
  assert.equal(url.pathname, '/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), '1335715488316611');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://dovroyn.com/api/integrations/callback');
  assert.deepEqual(url.searchParams.get('scope').split(','), ['instagram_basic', 'pages_show_list']);
  assert.equal(url.searchParams.has('pages_manage_posts'), false);
});

test('OAuth state requires same-browser HttpOnly cookie binding', () => {
  const record = stateRecord(1000);
  const cookie = buildOAuthCookie(record, config);
  assert.match(cookie, new RegExp(`${META_OAUTH_COOKIE}=v1\\.`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /access|token|mock-app-secret|code/i);
  assert.equal(validateOAuthCookie({ cookieHeader: cookie, state: record.state, now: 2000, config }).browserBindingHash, record.browserBindingHash);
  assert.equal(validateOAuthCookie({ cookieHeader: '', state: record.state, now: 2000, config }), null);
  assert.equal(validateOAuthCookie({ cookieHeader: cookie, state: 'C'.repeat(43), now: 2000, config }), null);
  assert.equal(validateOAuthCookie({ cookieHeader: cookie, state: record.state, now: record.expiresUnix * 1000 + 1, config }), null);
  assert.match(clearOAuthCookie(), /Max-Age=0/);
});

test('tenant isolation comes from trusted pod ownership plus consumed browser-bound state', async () => {
  assert.throws(() => authorizeMetaConnection({
    pod: null,
    user: { id: 'user-1' },
    subscription: activePaidSubscription,
    requestedProviderKey: 'instagram',
    idempotencyKey: 'connect:instagram:tenant',
  }), /authorized|connection/i);

  const record = stateRecord();
  const cookie = buildOAuthCookie(record, config);
  const stored = [];
  const result = await completeMetaCallback({
    code: 'mock-code',
    state: record.state,
    cookieHeader: cookie,
  }, {
    config,
    rpcWithServiceRole: async (name, body) => {
      if (name === 'consume_meta_organic_oauth_state') {
        assert.equal(body.p_state_hash, record.stateHash);
        assert.equal(body.p_browser_binding_hash, record.browserBindingHash);
        return {
          user_id: '00000000-0000-0000-0000-000000000010',
          pod_id: '00000000-0000-0000-0000-000000000020',
          redirect_uri: config.redirectUri,
        };
      }
      stored.push({ name, body });
      return 'connection-1';
    },
    fetch: mockFetch([
      { payload: { access_token: 'short-token', expires_in: 60 } },
      { payload: { access_token: 'long-token', expires_in: 3600 } },
      { payload: { data: META_ORGANIC_SCOPES.map((permission) => ({ permission, status: 'granted' })) } },
      { payload: { data: [{ name: 'Meet Millie Ai', instagram_business_account: { id: '994698870063199', username: 'meetmillieai' } }] } },
    ]).fetch,
    encryptProviderToken: () => 'encrypted-token',
  });
  assert.equal(result.podId, '00000000-0000-0000-0000-000000000020');
  assert.equal(stored[0].name, 'store_meta_organic_connection');
  assert.equal(stored[0].body.p_user_id, '00000000-0000-0000-0000-000000000010');
  assert.equal(stored[0].body.p_pod_id, '00000000-0000-0000-0000-000000000020');
});

test('cross-browser, replayed, expired, or redirect-mismatched state fails before token storage', async () => {
  const record = stateRecord();
  await assert.rejects(() => completeMetaCallback({
    code: 'mock-code',
    state: record.state,
    cookieHeader: '',
  }, { config, rpcWithServiceRole: async () => assert.fail('state must not consume without cookie') }), /browser binding|CSRF|OAuth/i);

  const cookie = buildOAuthCookie(record, config);
  for (const consumed of [null, { user_id: 'u', pod_id: 'p', redirect_uri: 'https://evil.example/callback' }]) {
    await assert.rejects(() => completeMetaCallback({
      code: 'mock-code',
      state: record.state,
      cookieHeader: cookie,
    }, {
      config,
      rpcWithServiceRole: async (name) => name === 'consume_meta_organic_oauth_state' ? consumed : assert.fail('storage must not run'),
    }), /state/i);
  }
});

test('readiness gate fails closed until explicit activation and compatible RPC contract', async () => {
  assert.equal(getMetaOrganicConfig({
    META_APP_ID: '1335715488316611',
    META_APP_SECRET: 'mock-secret',
    META_OAUTH_REDIRECT_URI: config.redirectUri,
    META_TOKEN_ENCRYPTION_KEY: config.encryptionKey,
    META_TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
    META_ORGANIC_CONNECTIONS_ENABLED: 'false',
  }).configured, true);
  await assert.rejects(() => assertMetaOrganicReady({ ...config, activationEnabled: false }, {
    rpcWithServiceRole: async () => assert.fail('RPC must not be called when activation gate is off'),
  }), /cutover|storage|enabled/i);
  assert.deepEqual(await loadMetaOrganicReadiness(config, {
    rpcWithServiceRole: async () => ({ ready: true, contract_version: 'wrong', required_scopes: META_ORGANIC_SCOPES }),
  }), { ready: false, reason: 'storage_unavailable' });
  assert.equal((await assertMetaOrganicReady(config, {
    rpcWithServiceRole: async () => ({ ready: true, contract_version: config.contractVersion, required_scopes: META_ORGANIC_SCOPES }),
  })).ready, true);
});

test('connect route requires authentication and missing setup fails closed without secret exposure', async () => {
  const original = { ...process.env };
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_TOKEN_ENCRYPTION_KEY;
  delete process.env.META_TOKEN_ENCRYPTION_KEY_VERSION;
  const unauth = mockRes();
  await connectHandler({ method: 'POST', headers: {}, body: { podId: 'pod' } }, unauth);
  assert.equal(unauth.statusCode, 401);

  const missingConfig = mockRes();
  await connectHandler({ method: 'POST', headers: { authorization: 'Bearer user-token' }, body: { podId: 'pod' } }, missingConfig);
  assert.equal(missingConfig.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(missingConfig.body), /secret|token|mock/i);
  process.env = original;
});

test('provider token exchange uses POST form body and Graph reads use bearer headers', async () => {
  const record = stateRecord();
  const transport = mockFetch([
    { payload: { access_token: 'short-token', expires_in: 60 } },
    { payload: { access_token: 'long-token', expires_in: 3600 } },
    { payload: { data: META_ORGANIC_SCOPES.map((permission) => ({ permission, status: 'granted' })) } },
    { payload: { data: [{ name: 'Meet Millie Ai', instagram_business_account: { id: '994698870063199', username: 'meetmillieai' } }] } },
  ]);
  await completeMetaCallback({
    code: 'mock-code',
    state: record.state,
    cookieHeader: buildOAuthCookie(record, config),
  }, {
    config,
    rpcWithServiceRole: async (name) => name === 'consume_meta_organic_oauth_state'
      ? { user_id: 'u', pod_id: 'p', redirect_uri: config.redirectUri }
      : 'connection-id',
    fetch: transport.fetch,
    encryptProviderToken: () => 'encrypted-token',
  });
  assert.equal(transport.calls[0].options.method, 'POST');
  assert.equal(transport.calls[1].options.method, 'POST');
  assert.doesNotMatch(transport.calls[0].url, /mock-code|mock-app-secret|short-token|long-token/);
  assert.doesNotMatch(transport.calls[1].url, /mock-code|mock-app-secret|short-token|long-token/);
  assert.equal(transport.calls[2].options.headers.Authorization, 'Bearer long-token');
  assert.equal(transport.calls[3].options.headers.Authorization, 'Bearer long-token');
  assert.doesNotMatch(transport.calls[2].url, /access_token|long-token/);
});

test('denied or missing Meta scopes and provider failures sanitize outcomes', async () => {
  assert.throws(() => validateGrantedScopes(['instagram_basic']), /permissions/);
  await assert.rejects(() => completeMetaCallback({ errorCode: 'access_denied', state: 'A'.repeat(43) }, { config }), /denied/);
  const record = stateRecord();
  await assert.rejects(() => completeMetaCallback({
    code: 'secret-code',
    state: record.state,
    cookieHeader: buildOAuthCookie(record, config),
  }, {
    config,
    rpcWithServiceRole: async (name) => name === 'consume_meta_organic_oauth_state'
      ? { user_id: 'u', pod_id: 'p', redirect_uri: config.redirectUri }
      : assert.fail('storage must not run'),
    fetch: mockFetch([{ payload: { error: { message: 'raw-provider-secret-token' } }, status: 500 }]).fetch,
  }), /provider/i);
});

test('account selection handles pagination and rejects ambiguous linked Instagram accounts', async () => {
  const paged = mockFetch([
    { payload: { data: [], paging: { next: 'https://graph.facebook.com/v26.0/me/accounts?after=cursor-secret&access_token=must-not-reuse' } } },
    { payload: { data: [{ name: 'Meet Millie Ai', instagram_business_account: { id: '994698870063199', username: 'meetmillieai' } }] } },
  ]);
  const account = await loadInstagramAccount('long-token', { config, fetch: paged.fetch });
  assert.equal(account.providerAccountId, '994698870063199');
  assert.match(paged.calls[1].url, /after=cursor-secret/);
  assert.doesNotMatch(paged.calls[1].url, /access_token|must-not-reuse/);

  await assert.rejects(() => loadInstagramAccount('long-token', { config, fetch: mockFetch([
    { payload: { data: [
      { name: 'A', instagram_business_account: { id: '1', username: 'a' } },
      { name: 'B', instagram_business_account: { id: '2', username: 'b' } },
    ] } },
  ]).fetch }), /Multiple Instagram/);
});

test('status normalization handles labels and expired credentials', () => {
  assert.deepEqual(normalizeConnection({
    id: 'c1',
    provider: 'instagram',
    provider_account_id: '123',
    account_label: '  Meet\u0000 Millie Ai  ',
    status: 'connected',
    granted_scopes: META_ORGANIC_SCOPES,
    expires_at: '2099-01-01T00:00:00.000Z',
  }, Date.parse('2026-01-01T00:00:00.000Z')).accountLabel, 'Meet Millie Ai');
  assert.equal(normalizeConnection({
    provider: 'instagram',
    accountLabel: 'Meet Millie Ai',
    status: 'connected',
    expiresAt: '2020-01-01T00:00:00.000Z',
  }, Date.parse('2026-01-01T00:00:00.000Z')).status, 'expired');
});

test('AES-GCM token encryption is decryptable with mock key and does not expose raw token', () => {
  const iv = Buffer.alloc(12, 7);
  const encrypted = encryptProviderToken('long-token-secret', config, iv);
  assert.doesNotMatch(encrypted, /long-token-secret/);
  const bytes = Buffer.from(encrypted, 'base64url');
  assert.equal(bytes.subarray(0, 12).equals(iv), true);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKeyBytes, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  assert.equal(plain, 'long-token-secret');
});

test('callback redirects to the pod route when state identifies a trusted pod', () => {
  const success = buildIntegrationRedirect({ podId: 'pod-123', status: 'connected', connectionId: 'conn-123' });
  assert.equal(new URL(success).pathname, '/pods/pod-123');
  const failure = buildIntegrationRedirect({ status: 'error', reason: 'csrf_failed' });
  assert.equal(new URL(failure).pathname, '/pods');
  assert.equal(new URL(failure).searchParams.get('reason'), 'csrf_failed');
});

test('proposed migration source aligns discovery-only contract and leaves publisher disabled', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261012000000_proposed_meta_organic_connection_cutover.sql', import.meta.url), 'utf8');
  assert.match(sql, /PROPOSED ONLY/);
  assert.match(sql, /get_meta_organic_connection_readiness/);
  assert.match(sql, /create_meta_organic_oauth_state/);
  assert.match(sql, /consume_meta_organic_oauth_state/);
  assert.match(sql, /store_meta_organic_connection/);
  assert.match(sql, /browser_binding_hash/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.social_connections FROM authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.store_meta_organic_connection/);
  assert.match(sql, /'instagram_basic','pages_show_list'/);
  assert.match(sql, /pages_manage_posts/);
  assert.match(sql, /Publisher functions.*intentionally not granted\/enabled/s);
});
