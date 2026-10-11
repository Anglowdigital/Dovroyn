import test from 'node:test';
import assert from 'node:assert/strict';

import connectHandler from '../api/integrations/meta/connect.js';
import {
  authorizeMetaConnection,
  buildMetaAuthorizeUrl,
  completeMetaCallback,
  createStateRecord,
  getMetaOrganicConfig,
  hashIncomingState,
  META_ORGANIC_SCOPES,
  validateGrantedScopes,
} from '../api/_lib/metaOrganic.js';

const activePaidSubscription = Object.freeze({
  tier: 'starter',
  status: 'active',
  current_period_end: '2099-01-01T00:00:00.000Z',
});

const config = Object.freeze({
  appId: '1335715488316611',
  appSecret: 'mock-secret',
  redirectUri: 'https://dovroyn.com/api/integrations/callback',
  graphVersion: 'v26.0',
  encryptionKey: 'A'.repeat(43),
  encryptionKeyVersion: 'test-v1',
  configured: true,
  scopes: [...META_ORGANIC_SCOPES],
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
    fetch: async (url) => {
      calls.push(String(url));
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

test('Meta authorization URL uses Facebook Login with least-privilege organic scopes', () => {
  const url = new URL(buildMetaAuthorizeUrl(config, 'state_123456789012345678901234567890'));
  assert.equal(url.hostname, 'www.facebook.com');
  assert.equal(url.pathname, '/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), '1335715488316611');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://dovroyn.com/api/integrations/callback');
  assert.deepEqual(url.searchParams.get('scope').split(','), ['instagram_basic', 'pages_show_list']);
  assert.equal(url.searchParams.has('pages_manage_posts'), false);
});

test('OAuth state is hashed for storage and rejects malformed incoming state', () => {
  const record = createStateRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    redirectUri: config.redirectUri,
    random: () => 'A'.repeat(43),
  });
  assert.equal(record.state, 'A'.repeat(43));
  assert.match(record.stateHash, /^[a-f0-9]{64}$/);
  assert.equal(hashIncomingState(record.state), record.stateHash);
  assert.equal(hashIncomingState('../not-state'), '');
});

test('tenant isolation comes from trusted pod ownership and consumed state, not browser fields', async () => {
  assert.throws(() => authorizeMetaConnection({
    pod: null,
    user: { id: 'user-1' },
    subscription: activePaidSubscription,
    requestedProviderKey: 'instagram',
    idempotencyKey: 'connect:instagram:tenant',
  }), /authorized|Pod|connection/i);

  const stored = [];
  const result = await completeMetaCallback({
    code: 'code',
    state: 'A'.repeat(43),
  }, {
    config,
    consumeOAuthState: undefined,
    rpcWithServiceRole: async (name, body) => {
      if (name === 'consume_instagram_oauth_state') return {
        user_id: '00000000-0000-0000-0000-000000000010',
        pod_id: '00000000-0000-0000-0000-000000000020',
        redirect_uri: config.redirectUri,
      };
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
  assert.equal(stored[0].body.p_user_id, '00000000-0000-0000-0000-000000000010');
  assert.equal(stored[0].body.p_pod_id, '00000000-0000-0000-0000-000000000020');
  assert.equal(stored[0].body.p_provider_account_id, '994698870063199');
});

test('replayed, expired, or redirect-mismatched state fails closed before token storage', async () => {
  for (const consumed of [null, { user_id: 'u', pod_id: 'p', redirect_uri: 'https://evil.example/callback' }]) {
    await assert.rejects(() => completeMetaCallback({
      code: 'code',
      state: 'A'.repeat(43),
    }, {
      config,
      rpcWithServiceRole: async (name) => name === 'consume_instagram_oauth_state' ? consumed : assert.fail('storage must not run'),
    }), /state/i);
  }
});

test('denied or missing Meta scopes fail without storing credentials', async () => {
  assert.throws(() => validateGrantedScopes(['instagram_basic']), /permissions/);
  await assert.rejects(() => completeMetaCallback({ errorCode: 'access_denied', state: 'A'.repeat(43) }, { config }), /denied/);
  await assert.rejects(() => completeMetaCallback({
    code: 'code',
    state: 'A'.repeat(43),
  }, {
    config,
    rpcWithServiceRole: async (name) => name === 'consume_instagram_oauth_state'
      ? { user_id: 'u', pod_id: 'p', redirect_uri: config.redirectUri }
      : assert.fail('storage must not run'),
    fetch: mockFetch([
      { payload: { access_token: 'short-token', expires_in: 60 } },
      { payload: { access_token: 'long-token', expires_in: 3600 } },
      { payload: { data: [{ permission: 'instagram_basic', status: 'granted' }] } },
    ]).fetch,
  }), /permissions/);
});

test('provider failures and missing page-linked Instagram account fail closed', async () => {
  await assert.rejects(() => completeMetaCallback({
    code: 'code',
    state: 'A'.repeat(43),
  }, {
    config,
    rpcWithServiceRole: async (name) => name === 'consume_instagram_oauth_state'
      ? { user_id: 'u', pod_id: 'p', redirect_uri: config.redirectUri }
      : assert.fail('storage must not run'),
    fetch: mockFetch([{ payload: { error: { message: 'raw provider secret' } }, status: 500 }]).fetch,
  }), /provider/i);

  await assert.rejects(() => completeMetaCallback({
    code: 'code',
    state: 'A'.repeat(43),
  }, {
    config,
    rpcWithServiceRole: async (name) => name === 'consume_instagram_oauth_state'
      ? { user_id: 'u', pod_id: 'p', redirect_uri: config.redirectUri }
      : assert.fail('storage must not run'),
    fetch: mockFetch([
      { payload: { access_token: 'short-token', expires_in: 60 } },
      { payload: { access_token: 'long-token', expires_in: 3600 } },
      { payload: { data: META_ORGANIC_SCOPES.map((permission) => ({ permission, status: 'granted' })) } },
      { payload: { data: [{ id: '1224063290785757', name: 'Meet Millie Ai' }] } },
    ]).fetch,
  }), /Instagram professional account/);
});

test('connect route requires authentication and missing live configuration fails closed without secret exposure', async () => {
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
  assert.doesNotMatch(JSON.stringify(missingConfig.body), /secret|token|app secret/i);
  process.env = original;
});

test('configuration reports unready until every server-only secret placeholder is present', () => {
  assert.equal(getMetaOrganicConfig({
    META_APP_ID: '1335715488316611',
    META_APP_SECRET: 'mock-secret',
    META_OAUTH_REDIRECT_URI: config.redirectUri,
    META_TOKEN_ENCRYPTION_KEY: '',
    META_TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
  }).configured, false);
  assert.equal(getMetaOrganicConfig({
    META_APP_ID: '1335715488316611',
    META_APP_SECRET: 'mock-secret',
    META_OAUTH_REDIRECT_URI: config.redirectUri,
    META_TOKEN_ENCRYPTION_KEY: 'A'.repeat(43),
    META_TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
  }).configured, true);
});
