import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import connectHandler from '../api/integrations/meta/connect.js';
import selectionHandler from '../api/integrations/meta/selection.js';
import {
  assertMetaOrganicReady,
  authorizeMetaConnection,
  buildIntegrationRedirect,
  buildMetaAuthorizeUrl,
  buildOAuthCookie,
  buildAtomicSelectionCommit,
  clearOAuthCookie,
  completeMetaCallback,
  createSelectionRecord,
  createStateRecord,
  decryptPendingCandidates,
  decryptProviderPayload,
  discoverMetaAccountCandidates,
  encryptProviderToken,
  getMetaOrganicConfig,
  getMetaSelectionForClient,
  hashIncomingState,
  loadInstagramAccount,
  loadMetaOrganicReadiness,
  selectMetaAccounts,
  META_OAUTH_COOKIE,
  META_ORGANIC_CONTRACT_VERSION,
  META_ORGANIC_PROVENANCE,
  META_ORGANIC_SCOPES,
  META_FACEBOOK_PROVIDER_KEY,
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
  contractVersion: 'meta_organic_facebook_login_selection_v2',
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
      { payload: { data: [{ id: '1224063290785757', name: 'Meet Millie Ai', access_token: 'page-token', instagram_business_account: { id: '994698870063199' } }] } },
    ]).fetch,
    encryptProviderToken: () => 'encrypted-token',
  });
  assert.equal(result.podId, '00000000-0000-0000-0000-000000000020');
  assert.equal(result.selectionRequired, true);
  assert.equal(stored[0].name, 'create_meta_organic_pending_selection');
  assert.equal(stored[0].body.p_user_id, '00000000-0000-0000-0000-000000000010');
  assert.equal(stored[0].body.p_pod_id, '00000000-0000-0000-0000-000000000020');
  assert.doesNotMatch(JSON.stringify(result), /page-token|long-token|encrypted-token/);
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
  assert.deepEqual(await loadMetaOrganicReadiness(config, {
    rpcWithServiceRole: async () => ({
      ready: true,
      contract_version: 'meta_organic_facebook_login_v1',
      provider_verified_source: META_ORGANIC_PROVENANCE,
      required_scopes: META_ORGANIC_SCOPES,
    }),
  }), { ready: false, reason: 'storage_unavailable' });
  assert.deepEqual(await loadMetaOrganicReadiness(config, {
    rpcWithServiceRole: async () => ({ ready: true, contract_version: config.contractVersion, required_scopes: META_ORGANIC_SCOPES }),
  }), { ready: false, reason: 'storage_unavailable' });
  assert.equal((await assertMetaOrganicReady(config, {
    rpcWithServiceRole: async () => ({
      ready: true,
      contract_version: config.contractVersion,
      provider_verified_source: META_ORGANIC_PROVENANCE,
      required_scopes: META_ORGANIC_SCOPES,
    }),
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

test('connect route binds Facebook Page-only flow to pages_show_list without Instagram scope', async () => {
  const original = { ...process.env };
  process.env.META_APP_ID = config.appId;
  process.env.META_APP_SECRET = config.appSecret;
  process.env.META_OAUTH_REDIRECT_URI = config.redirectUri;
  process.env.META_TOKEN_ENCRYPTION_KEY = config.encryptionKey;
  process.env.META_TOKEN_ENCRYPTION_KEY_VERSION = config.encryptionKeyVersion;
  process.env.META_OAUTH_COOKIE_SECRET = config.cookieSecret;
  process.env.META_ORGANIC_CONNECTIONS_ENABLED = 'true';
  process.env.VITE_SUPABASE_URL = 'https://pod.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-test-key';
  const rpcCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.includes('/auth/v1/user')) return jsonResponse({ id: '00000000-0000-0000-0000-000000000001' });
    if (parsed.pathname.endsWith('/rest/v1/pods')) return jsonResponse([{ id: '00000000-0000-0000-0000-000000000002', user_id: '00000000-0000-0000-0000-000000000001' }]);
    if (parsed.pathname.endsWith('/rest/v1/subscriptions')) return jsonResponse([activePaidSubscription]);
    if (parsed.pathname.endsWith('/rest/v1/rpc/get_meta_organic_connection_readiness')) return jsonResponse({
      ready: true,
      contract_version: config.contractVersion,
      provider_verified_source: META_ORGANIC_PROVENANCE,
      required_scopes: META_ORGANIC_SCOPES,
    });
    if (parsed.pathname.endsWith('/rest/v1/rpc/create_meta_organic_oauth_state')) {
      rpcCalls.push(JSON.parse(options.body));
      return jsonResponse(null);
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const res = mockRes();
    await connectHandler({
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: { podId: '00000000-0000-0000-0000-000000000002', providerKey: 'facebook', idempotencyKey: 'connect:facebook:test' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.requiredScopes, ['pages_show_list']);
    assert.equal(new URL(res.body.authorizationUrl).searchParams.get('scope'), 'pages_show_list');
    assert.equal(rpcCalls[0].p_requested_provider, 'facebook');
    assert.deepEqual(rpcCalls[0].p_required_scopes, ['pages_show_list']);
  } finally {
    global.fetch = originalFetch;
    process.env = original;
  }
});

test('selection route fails closed when activation/readiness is disabled before storage or provider work', async () => {
  const original = { ...process.env };
  process.env.META_APP_ID = config.appId;
  process.env.META_APP_SECRET = config.appSecret;
  process.env.META_OAUTH_REDIRECT_URI = config.redirectUri;
  process.env.META_TOKEN_ENCRYPTION_KEY = config.encryptionKey;
  process.env.META_TOKEN_ENCRYPTION_KEY_VERSION = config.encryptionKeyVersion;
  process.env.META_OAUTH_COOKIE_SECRET = config.cookieSecret;
  process.env.META_ORGANIC_CONNECTIONS_ENABLED = 'false';
  const res = mockRes();
  await selectionHandler({
    method: 'POST',
    headers: { authorization: 'Bearer user-token' },
    body: { podId: 'pod', selectionId: 'S'.repeat(43), facebookPageId: '1224063290785757' },
  }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /secret|user-token|1224063290785757/);
  process.env = original;
});

test('provider token exchange follows documented GET and Graph reads use bearer headers', async () => {
  const record = stateRecord();
  const transport = mockFetch([
    { payload: { access_token: 'short-token', expires_in: 60 } },
    { payload: { access_token: 'long-token', expires_in: 3600 } },
    { payload: { data: META_ORGANIC_SCOPES.map((permission) => ({ permission, status: 'granted' })) } },
    { payload: { data: [{ id: '1224063290785757', name: 'Meet Millie Ai', access_token: 'page-token', instagram_business_account: { id: '994698870063199' } }] } },
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
  assert.equal(transport.calls[0].options.method, 'GET');
  assert.equal(transport.calls[1].options.method, 'GET');
  assert.equal(transport.calls[0].options.redirect, 'manual');
  assert.equal(transport.calls[1].options.redirect, 'manual');
  assert.match(transport.calls[0].url, /code=mock-code/);
  assert.match(transport.calls[0].url, /client_secret=mock-app-secret/);
  assert.equal(transport.calls[2].options.headers.Authorization, 'Bearer long-token');
  assert.equal(transport.calls[3].options.headers.Authorization, 'Bearer long-token');
  assert.doesNotMatch(transport.calls[2].url, /access_token|long-token/);
  assert.equal(new URL(transport.calls[3].url).searchParams.get('fields'), 'id,name,access_token,instagram_business_account');
  assert.doesNotMatch(JSON.stringify(transport.calls[3].options), /page-token/);
});

test('Page-only callback accepts declined Instagram permission and avoids Instagram discovery fields', async () => {
  const record = stateRecord();
  const transport = mockFetch([
    { payload: { access_token: 'short-token', expires_in: 60 } },
    { payload: { access_token: 'long-token', expires_in: 3600 } },
    { payload: { data: [
      { permission: 'pages_show_list', status: 'granted' },
      { permission: 'instagram_basic', status: 'declined' },
    ] } },
    { payload: { data: [{ id: '1224063290785757', name: 'Meet Millie Ai', access_token: 'page-token' }] } },
  ]);
  const stored = [];
  const result = await completeMetaCallback({
    code: 'mock-code',
    state: record.state,
    cookieHeader: buildOAuthCookie(record, config),
  }, {
    config,
    rpcWithServiceRole: async (name, body) => {
      if (name === 'consume_meta_organic_oauth_state') return {
        user_id: 'u',
        pod_id: 'p',
        redirect_uri: config.redirectUri,
        requested_provider: 'facebook',
        required_scopes: ['pages_show_list'],
      };
      stored.push({ name, body });
      return null;
    },
    fetch: transport.fetch,
    encryptProviderToken: () => 'encrypted-token',
  });
  assert.equal(result.selectionRequired, true);
  assert.deepEqual(stored[0].body.p_granted_scopes, ['pages_show_list']);
  assert.equal(new URL(transport.calls[3].url).searchParams.get('fields'), 'id,name,access_token');
  assert.doesNotMatch(transport.calls[3].url, /instagram_business_account/);
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
    { payload: { data: [{ id: '1224063290785757', name: 'Meet Millie Ai', instagram_business_account: { id: '994698870063199' } }] } },
  ]);
  const account = await loadInstagramAccount('long-token', { config, fetch: paged.fetch });
  assert.deepEqual(account, {
    providerAccountId: '994698870063199',
    accountLabel: 'Meet Millie Ai Instagram (994698870063199)',
  });
  assert.match(paged.calls[1].url, /after=cursor-secret/);
  assert.match(new URL(paged.calls[1].url).searchParams.get('fields'), /access_token/);
  assert.doesNotMatch(paged.calls[1].url, /must-not-reuse/);

  await assert.rejects(() => loadInstagramAccount('long-token', { config, fetch: mockFetch([
    { payload: { data: [
      { id: '11', name: 'A', instagram_business_account: { id: '1' } },
      { id: '22', name: 'B', instagram_business_account: { id: '2' } },
    ] } },
  ]).fetch }), /Multiple Instagram/);

  const tooManyPages = Array.from({ length: 10 }, (_, index) => ({
    payload: {
      data: index === 0 ? [{ id: '11', name: 'A', instagram_business_account: { id: '1' } }] : [],
      paging: { next: `https://graph.facebook.com/v26.0/me/accounts?after=cursor-${index}` },
    },
  }));
  await assert.rejects(() => loadInstagramAccount('long-token', { config, fetch: mockFetch(tooManyPages).fetch }), /enumerate all/);
});

test('Meta discovery returns explicit Page and Instagram candidates without exposing credentials to the browser', async () => {
  const transport = mockFetch([
    { payload: { data: [
      { id: '1224063290785757', name: 'Meet Millie Ai', access_token: 'page-token-1', instagram_business_account: { id: '994698870063199' } },
      { id: '2222222222222222', name: 'Second Brand', access_token: 'page-token-2' },
    ] } },
  ]);
  const candidates = await discoverMetaAccountCandidates('user-token', { config, fetch: transport.fetch });
  assert.equal(candidates.pages.length, 2);
  assert.equal(candidates.pages[0].pageAccessToken, 'page-token-1');
  const selection = createSelectionRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    token: 'user-token-secret',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    grantedScopes: [...META_ORGANIC_SCOPES, 'pages_manage_posts'],
    candidates,
    config,
    random: () => 'C'.repeat(43),
  });
  assert.doesNotMatch(JSON.stringify(selection), /page-token|user-token-secret/);
  const clientSelection = await getMetaSelectionForClient({
    selectionId: selection.selectionId,
    userId: selection.userId,
    podId: selection.podId,
  }, {
    config,
    rpcWithServiceRole: async () => selection,
  });
  assert.deepEqual(clientSelection.pages.map((page) => page.label), ['Meet Millie Ai', 'Second Brand']);
  assert.doesNotMatch(JSON.stringify(clientSelection), /page-token|user-token-secret/);
});

test('Meta selection validates browser choices before atomic commit and preserves pending selection on invalid IDs', async () => {
  const selection = createSelectionRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    token: 'user-token-secret',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    grantedScopes: META_ORGANIC_SCOPES,
    candidates: {
      pages: [{ id: '1224063290785757', label: 'Meet Millie Ai', pageAccessToken: 'page-token-secret', instagramAccount: { id: '994698870063199', label: 'Meet Millie Ai Instagram (994698870063199)', pageId: '1224063290785757', pageLabel: 'Meet Millie Ai' } }],
    },
    config,
    random: () => 'D'.repeat(43),
  });
  const calls = [];
  await assert.rejects(() => selectMetaAccounts({
    selectionId: selection.selectionId,
    userId: selection.userId,
    podId: selection.podId,
    selectedFacebookPageId: '999999999999',
  }, {
    config,
    rpcWithServiceRole: async (name) => {
      calls.push(name);
      if (name === 'get_meta_organic_pending_selection') return selection;
      assert.fail('invalid choice must not consume or commit pending selection');
    },
  }), /eligible/);
  assert.deepEqual(calls, ['get_meta_organic_pending_selection']);
});

test('Meta selection commits Page and Instagram together with correct token kinds and filtered scopes', async () => {
  const selection = createSelectionRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    token: 'user-token-secret',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    grantedScopes: [...META_ORGANIC_SCOPES, 'pages_manage_posts'],
    candidates: {
      pages: [{ id: '1224063290785757', label: 'Meet Millie Ai', pageAccessToken: 'page-token-secret', instagramAccount: { id: '994698870063199', label: 'Meet Millie Ai Instagram (994698870063199)', pageId: '1224063290785757', pageLabel: 'Meet Millie Ai' } }],
    },
    config,
    random: () => 'E'.repeat(43),
  });
  const committed = [];
  const result = await selectMetaAccounts({
    selectionId: selection.selectionId,
    userId: selection.userId,
    podId: selection.podId,
    selectedFacebookPageId: '1224063290785757',
    selectedInstagramAccountId: '994698870063199',
  }, {
    config,
    rpcWithServiceRole: async (name, body) => {
      if (name === 'get_meta_organic_pending_selection') return selection;
      if (name === 'commit_meta_organic_account_selection') {
        committed.push(body);
        return { connections: [{ provider: 'facebook' }, { provider: 'instagram' }] };
      }
      assert.fail(`unexpected RPC ${name}`);
    },
  });
  assert.deepEqual(result.connections.map((connection) => connection.provider), ['facebook', 'instagram']);
  const facebookPage = committed[0].p_facebook_page;
  const instagramAccount = committed[0].p_instagram_account;
  assert.equal(facebookPage.tokenKind, 'page');
  assert.equal(instagramAccount.tokenKind, 'user');
  assert.deepEqual(facebookPage.grantedScopes, ['pages_show_list']);
  assert.deepEqual(instagramAccount.grantedScopes, ['instagram_basic', 'pages_show_list']);
  assert.equal(decryptProviderPayload(facebookPage.encryptedAccessToken, config), 'page-token-secret');
  assert.equal(decryptProviderPayload(instagramAccount.encryptedAccessToken, config), 'user-token-secret');
  assert.doesNotMatch(JSON.stringify(committed), /page-token-secret|user-token-secret/);
});

test('Meta selection rejects a replayed or expired atomic commit after pending read race', async () => {
  const selection = createSelectionRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    token: 'user-token-secret',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    grantedScopes: ['pages_show_list'],
    candidates: {
      pages: [{ id: '1224063290785757', label: 'Meet Millie Ai', pageAccessToken: 'page-token-secret' }],
    },
    config,
    random: () => 'I'.repeat(43),
  });
  await assert.rejects(() => selectMetaAccounts({
    selectionId: selection.selectionId,
    userId: selection.userId,
    podId: selection.podId,
    selectedFacebookPageId: '1224063290785757',
  }, {
    config,
    rpcWithServiceRole: async (name) => {
      if (name === 'get_meta_organic_pending_selection') return selection;
      if (name === 'commit_meta_organic_account_selection') return null;
      assert.fail(`unexpected RPC ${name}`);
    },
  }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'expired_state');
    return true;
  });
});

test('Facebook Page selection without Page credential is rejected before consuming pending selection', async () => {
  const selection = createSelectionRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    token: 'user-token-secret',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    grantedScopes: META_ORGANIC_SCOPES,
    candidates: {
      pages: [{ id: '1224063290785757', label: 'Meet Millie Ai', instagramAccount: { id: '994698870063199', label: 'Meet Millie Ai Instagram (994698870063199)', pageId: '1224063290785757', pageLabel: 'Meet Millie Ai' } }],
    },
    config,
    random: () => 'G'.repeat(43),
  });
  const clientSelection = await getMetaSelectionForClient({
    selectionId: selection.selectionId,
    userId: selection.userId,
    podId: selection.podId,
  }, {
    config,
    rpcWithServiceRole: async () => selection,
  });
  assert.equal(clientSelection.pages[0].pageCredentialAvailable, false);
  const calls = [];
  await assert.rejects(() => selectMetaAccounts({
    selectionId: selection.selectionId,
    userId: selection.userId,
    podId: selection.podId,
    selectedFacebookPageId: '1224063290785757',
  }, {
    config,
    rpcWithServiceRole: async (name) => {
      calls.push(name);
      if (name === 'get_meta_organic_pending_selection') return selection;
      assert.fail('missing Page token must not consume or commit pending selection');
    },
  }), /Page credential/);
  assert.deepEqual(calls, ['get_meta_organic_pending_selection']);
});

test('Instagram selection without instagram_basic fails before consuming pending selection', async () => {
  const selection = createSelectionRecord({
    userId: '00000000-0000-0000-0000-000000000001',
    podId: '00000000-0000-0000-0000-000000000002',
    token: 'user-token-secret',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    grantedScopes: ['pages_show_list'],
    candidates: {
      pages: [{ id: '1224063290785757', label: 'Meet Millie Ai', pageAccessToken: 'page-token-secret', instagramAccount: { id: '994698870063199', label: 'Meet Millie Ai Instagram (994698870063199)', pageId: '1224063290785757', pageLabel: 'Meet Millie Ai' } }],
    },
    config,
    random: () => 'H'.repeat(43),
  });
  const calls = [];
  await assert.rejects(() => selectMetaAccounts({
    selectionId: selection.selectionId,
    userId: selection.userId,
    podId: selection.podId,
    selectedInstagramAccountId: '994698870063199',
  }, {
    config,
    rpcWithServiceRole: async (name) => {
      calls.push(name);
      if (name === 'get_meta_organic_pending_selection') return selection;
      assert.fail('missing Instagram scope must not consume or commit pending selection');
    },
  }), /permissions/);
  assert.deepEqual(calls, ['get_meta_organic_pending_selection']);
});

test('atomic selection commit leaves rollback and exactly-once replay guarantees to one RPC transaction', () => {
  const selectionHash = hashIncomingState('F'.repeat(43));
  const sql = readFileSync(new URL('../supabase/proposed-migrations/20261012000000_proposed_meta_organic_connection_cutover.sql', import.meta.url), 'utf8');
  assert.match(sql, /commit_meta_organic_account_selection/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /private\.meta_store_connection\(p_user_id, p_pod_id, p_facebook_page\)/);
  assert.match(sql, /private\.meta_store_connection\(p_user_id, p_pod_id, p_instagram_account\)/);
  assert.match(sql, /DELETE FROM private\.meta_organic_pending_selections/);
  assert.doesNotMatch(sql, /REVOKE ALL ON SCHEMA private/);
  assert.equal(selectionHash.length, 64);
});

test('status normalization handles labels, provenance, and expired or invalid credentials', () => {
  assert.deepEqual(normalizeConnection({
    id: 'c1',
    provider: 'instagram',
    provider_account_id: '123',
    account_label: '  Meet\u0000 Millie Ai  ',
    status: 'connected',
    granted_scopes: META_ORGANIC_SCOPES,
    expires_at: '2099-01-01T00:00:00.000Z',
    provider_verified_source: META_ORGANIC_PROVENANCE,
    provider_contract_version: META_ORGANIC_CONTRACT_VERSION,
  }, Date.parse('2026-01-01T00:00:00.000Z')).accountLabel, 'Meet Millie Ai');
  assert.equal(normalizeConnection({
    provider: 'instagram',
    accountLabel: 'Meet Millie Ai',
    status: 'connected',
    expiresAt: '2020-01-01T00:00:00.000Z',
    providerVerifiedSource: META_ORGANIC_PROVENANCE,
    providerContractVersion: META_ORGANIC_CONTRACT_VERSION,
  }, Date.parse('2026-01-01T00:00:00.000Z')).status, 'expired');
  assert.equal(normalizeConnection({
    provider: 'instagram',
    accountLabel: 'Meet Millie Ai',
    status: 'connected',
    expiresAt: 'not-a-date',
    providerVerifiedSource: META_ORGANIC_PROVENANCE,
    providerContractVersion: META_ORGANIC_CONTRACT_VERSION,
  }, Date.parse('2026-01-01T00:00:00.000Z')).status, 'expired');
  assert.equal(normalizeConnection({
    provider: 'instagram',
    accountLabel: 'Meet Millie Ai',
    status: 'connected',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }, Date.parse('2026-01-01T00:00:00.000Z')).status, 'reconnect_required');
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

test('callback post-state provider failures preserve trusted pod context', async () => {
  const record = stateRecord();
  await assert.rejects(async () => completeMetaCallback({
    code: 'mock-code',
    state: record.state,
    cookieHeader: buildOAuthCookie(record, config),
  }, {
    config,
    rpcWithServiceRole: async (name) => (name === 'consume_meta_organic_oauth_state'
      ? { user_id: 'u', pod_id: 'trusted-pod', redirect_uri: config.redirectUri }
      : assert.fail('storage must not run after provider failure')),
    fetch: mockFetch([{ payload: { error: { message: 'raw-token' } }, status: 500 }]).fetch,
  }), (error) => {
    assert.equal(error.podId, 'trusted-pod');
    assert.equal(error.code, 'provider_unavailable');
    return true;
  });
});

test('proposed migration source aligns discovery-only contract and leaves publisher disabled', () => {
  const sql = readFileSync(new URL('../supabase/proposed-migrations/20261012000000_proposed_meta_organic_connection_cutover.sql', import.meta.url), 'utf8');
  assert.match(sql, /PROPOSED ONLY/);
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /get_meta_organic_connection_readiness/);
  assert.match(sql, /create_meta_organic_oauth_state/);
  assert.match(sql, /consume_meta_organic_oauth_state/);
  assert.match(sql, /create_meta_organic_pending_selection/);
  assert.match(sql, /get_meta_organic_pending_selection/);
  assert.match(sql, /commit_meta_organic_account_selection/);
  assert.match(sql, /list_meta_organic_connections/);
  assert.match(sql, /private\.meta_organic_connections/);
  assert.match(sql, /private\.meta_organic_credentials/);
  assert.match(sql, /browser_binding_hash/);
  assert.match(sql, /provider_verified_source/);
  assert.match(sql, /provider_contract_version/);
  assert.match(sql, /has_function_privilege\('service_role'/);
  assert.match(sql, /browser_private_access_denied/);
  assert.doesNotMatch(sql, /public\.social_connections\s+FROM authenticated/);
  assert.doesNotMatch(sql, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.social_connections/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.commit_meta_organic_account_selection/);
  assert.match(sql, /'instagram_basic','pages_show_list'/);
  assert.match(sql, /pages_manage_posts/);
  assert.match(sql, /Publisher functions.*intentionally not granted\/enabled/s);
});
