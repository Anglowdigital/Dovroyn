import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAtomicSelectionCommit, buildOAuthCookie, completeMetaCallback,
  createOAuthState, createSelectionRecord, createStateRecord,
  decryptProviderPayload, discoverMetaAccountCandidates,
  getMetaOrganicConfig, requiredScopesForProvider, selectMetaAccounts,
} from '../api/_lib/metaOrganic.js';

const userId = '00000000-0000-4000-8000-000000000001';
const podId = '00000000-0000-4000-8000-000000000002';
const publishScopes = ['instagram_basic', 'pages_show_list', 'instagram_content_publish', 'pages_read_engagement'];
const config = {
  appId: '123', appSecret: 'mock-app-secret', redirectUri: 'https://dovroyn.com/api/integrations/callback',
  graphVersion: 'v26.0', encryptionKey: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url'),
  encryptionKeyVersion: 'test-v1', cookieSecret: 'mock-cookie-secret', configured: true,
  activationEnabled: true, publishConnectionsEnabled: true,
  scopes: ['instagram_basic', 'pages_show_list'], contractVersion: 'meta_organic_facebook_login_selection_v2',
};
const publishContract = 'meta_organic_facebook_login_publish_selection_v1';
function response(payload) { return { ok: true, status: 200, json: async () => payload }; }
function providerFetch({ proof = {}, linkedId = '201', pageId = '101', missingToken = false } = {}) {
  return async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/oauth/access_token')) return response({ access_token: 'mock-user-token', expires_in: 3600 });
    if (parsed.pathname.endsWith('/me/permissions')) return response({ data: publishScopes.map(permission => ({ permission, status: 'granted' })) });
    if (parsed.pathname.endsWith('/me/accounts')) return response({ data: [{ id: '101', name: 'Page One', ...(missingToken ? {} : { access_token: 'mock-page-token' }) }] });
    if (parsed.pathname.endsWith('/debug_token')) return response({ data: {
      is_valid: true, app_id: '123', profile_id: '101',
      scopes: publishScopes, expires_at: 4070908800, data_access_expires_at: 4070908800, ...proof,
    } });
    if (parsed.pathname.endsWith('/101')) return response({ id: pageId, instagram_business_account: { id: linkedId } });
    assert.fail('Unexpected provider read');
  };
}
function readiness() {
  return { ready: true, contract_version: config.contractVersion, provider_verified_source: 'meta_organic_server_v1',
    required_scopes: config.scopes, publish_connection_ready: true, publish_connection_contract_version: publishContract };
}
async function publishingSelection() {
  return createSelectionRecord({
    userId, podId, token: 'mock-user-token', tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    grantedScopes: publishScopes, requestedProviderKey: 'instagram', connectionIntent: 'publish', config,
    candidates: await discoverMetaAccountCandidates('mock-user-token', {
      config, connectionIntent: 'publish', requestedProviderKey: 'instagram', requiredScopes: publishScopes,
      fetch: providerFetch(),
    }), random: () => 'C'.repeat(43),
  });
}
function commit(record, extra = {}) {
  return buildAtomicSelectionCommit({ selectionId: record.selectionId, userId, podId, record,
    selectedInstagramAccountId: '201', config, ...extra });
}

test('explicit publishing scopes leave discovery unchanged and avoid Facebook posting for Instagram', () => {
  assert.deepEqual(requiredScopesForProvider('instagram'), ['instagram_basic', 'pages_show_list']);
  assert.deepEqual(requiredScopesForProvider('instagram', 'publish'), publishScopes);
  assert.deepEqual(requiredScopesForProvider('facebook', 'publish'), ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement']);
  assert.throws(() => requiredScopesForProvider('instagram', 'forged'), /intent/i);
  assert.equal(getMetaOrganicConfig({}).publishConnectionsEnabled, false);
});

test('OAuth state persists explicit publishing intent on the server', async () => {
  const record = createStateRecord({ userId, podId, redirectUri: config.redirectUri,
    requestedProviderKey: 'instagram', connectionIntent: 'publish', requiredScopes: publishScopes });
  let saved;
  await createOAuthState(record, { rpcWithServiceRole: async (name, body) => { saved = { name, body }; } });
  assert.equal(saved.name, 'create_meta_organic_publish_oauth_state');
  assert.equal(record.connectionIntent, 'publish');
  assert.deepEqual(saved.body.p_required_scopes, publishScopes);
});

test('publishing callback verifies Page credentials and keeps server intent without exposing tokens', async () => {
  const state = createStateRecord({ userId, podId, redirectUri: config.redirectUri });
  let pending;
  const result = await completeMetaCallback({ code: 'mock-code', state: state.state,
    cookieHeader: buildOAuthCookie(state, config), connectionIntent: 'discovery' }, {
    config, fetch: providerFetch(),
    rpcWithServiceRole: async (name, body) => {
      if (name === 'consume_meta_organic_oauth_state') return {
        user_id: userId, pod_id: podId, redirect_uri: config.redirectUri,
        requested_provider: 'instagram', connection_intent: 'publish', required_scopes: publishScopes,
      };
      if (name === 'get_meta_organic_connection_readiness') return readiness();
      if (name === 'create_meta_organic_publish_pending_selection') { pending = body; return null; }
      assert.fail('Unexpected storage operation');
    },
  });
  assert.equal(result.selectionRequired, true);
  assert.equal(pending.p_requested_provider, 'instagram');
  assert.deepEqual(pending.p_granted_scopes, publishScopes);
  assert.doesNotMatch(JSON.stringify(result), /mock-page-token|mock-user-token|encrypted/i);
});

test('publishing selection stores the verified linked Page token for Instagram with provenance', async () => {
  const record = await publishingSelection();
  const payload = commit(record).instagramAccount;
  assert.equal(payload.tokenKind, 'page');
  assert.equal(decryptProviderPayload(payload.encryptedAccessToken, config), 'mock-page-token');
  assert.deepEqual(payload.grantedScopes, publishScopes);
  assert.equal(payload.connectionIntent, 'publish');
  assert.equal(payload.linkedFacebookPageId, '101');
  assert.equal(payload.providerContractVersion, publishContract);
  assert.equal(payload.providerAccountId, '201');
});

test('publishing token proof rejects wrong app, kind, Page identity, expiry or missing grants', async () => {
  for (const proof of [
    { is_valid: false }, { app_id: '999' }, { type: 'USER' }, { profile_id: '999' },
    { expires_at: 1 }, { data_access_expires_at: 1 }, { scopes: ['instagram_basic', 'pages_show_list'] },
  ]) {
    await assert.rejects(() => discoverMetaAccountCandidates('mock-user-token', {
      config, connectionIntent: 'publish', requestedProviderKey: 'instagram', requiredScopes: publishScopes,
      fetch: providerFetch({ proof }),
    }), /credential|permission|token/i);
  }
  await assert.rejects(() => discoverMetaAccountCandidates('mock-user-token', {
    config, connectionIntent: 'publish', requestedProviderKey: 'instagram', requiredScopes: publishScopes,
    fetch: providerFetch({ pageId: '999' }),
  }), /Page|account|credential/i);
});

test('publishing selection rejects forged intent, cross-owner choices and missing Page credentials', async () => {
  const record = await publishingSelection();
  assert.throws(() => commit(record, { userId: 'another-owner' }), /owner|context/i);
  assert.throws(() => commit(record, { podId: 'another-pod' }), /owner|context/i);
  assert.throws(() => commit(record, { selectedInstagramAccountId: '999' }), /eligible/i);
  assert.throws(() => commit(record, { selectedFacebookPageId: '101' }), /provider|intent/i);
  assert.throws(() => commit({ ...record, connectionIntent: 'forged' }), /intent/i);
  assert.throws(() => commit({ ...record, grantedScopes: config.scopes }), /permission|scope/i);
  const candidates = JSON.parse(decryptProviderPayload(record.encryptedCandidates, config));
  delete candidates.pages[0].pageAccessToken;
  const withoutCredential = createSelectionRecord({ userId, podId, token: 'mock-user-token',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: publishScopes,
    connectionIntent: 'publish', requestedProviderKey: 'instagram', candidates, config });
  assert.throws(() => commit(withoutCredential), /Page|credential/i);
});

test('callback rejects forged scopes and disabled publishing before provider reads', async () => {
  const state = createStateRecord({ userId, podId, redirectUri: config.redirectUri });
  for (const [intent, scopes, active] of [
    ['publish', config.scopes, true], ['forged', publishScopes, true], ['publish', publishScopes, false],
    ['discovery', publishScopes, true],
  ]) {
    await assert.rejects(() => completeMetaCallback({ code: 'mock-code', state: state.state, cookieHeader: buildOAuthCookie(state, config) }, {
      config: { ...config, publishConnectionsEnabled: active },
      fetch: async () => assert.fail('invalid publishing context must not contact provider'),
      rpcWithServiceRole: async (name) => name === 'get_meta_organic_connection_readiness' ? readiness() : ({
        user_id: userId, pod_id: podId, redirect_uri: config.redirectUri,
        requested_provider: 'instagram', connection_intent: intent, required_scopes: scopes,
      }),
    }), /intent|scope|permission|enabled|storage/i);
  }
});

test('selection cannot commit publishing intent under discovery-only readiness', async () => {
  const record = await publishingSelection();
  await assert.rejects(() => selectMetaAccounts({ selectionId: record.selectionId, userId, podId,
    selectedInstagramAccountId: '201', connectionIntent: 'discovery' }, {
    config,
    rpcWithServiceRole: async (name) => {
      if (name === 'get_meta_organic_pending_selection') return record;
      if (name === 'get_meta_organic_connection_readiness') return { ...readiness(), publish_connection_ready: false };
      assert.fail('stale readiness must not commit');
    },
  }), /storage|ready/i);
});

test('client connect seam sends explicit publish intent and keeps default discovery', async () => {
  const { initiateMetaOrganicConnection } = await import('../src/lib/metaOrganic.js');
  const original = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response({ authorizationUrl: 'https://www.facebook.com/mock-authorize' });
  };
  try {
    const target = { location: { assign() {} }, crypto: { randomUUID: () => 'mock-request-id' } };
    await initiateMetaOrganicConnection({ accessToken: 'mock-session', podId, target });
    await initiateMetaOrganicConnection({ accessToken: 'mock-session', podId, connectionIntent: 'publish', target });
    assert.equal(requests[0].connectionIntent, 'discovery');
    assert.equal(requests[1].connectionIntent, 'publish');
  } finally { global.fetch = original; }
});

test('discovery selection supports the actual v2 RPC response without returned owner fields', async () => {
  const selected = createSelectionRecord({ userId, podId, token: 'mock-user-token',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: config.scopes, config,
    candidates: { pages: [{ id: '101', label: 'Synthetic Page', pageAccessToken: 'mock-page-token',
      instagramAccount: { id: '201', label: 'Synthetic IG', pageId: '101' } }] } });
  const v2Response = {
    encrypted_access_token: selected.encryptedAccessToken, encrypted_candidates: selected.encryptedCandidates,
    granted_scopes: selected.grantedScopes, token_expires_at: selected.tokenExpiresAt,
    encryption_key_version: selected.encryptionKeyVersion,
  };
  const result = await selectMetaAccounts({ selectionId: selected.selectionId, userId, podId,
    selectedInstagramAccountId: '201' }, {
    config: { ...config, publishConnectionsEnabled: false },
    rpcWithServiceRole: async (name, body) => {
      assert.equal(body.p_user_id, userId);
      assert.equal(body.p_pod_id, podId);
      if (name === 'get_meta_organic_pending_selection') return v2Response;
      if (name === 'commit_meta_organic_account_selection') {
        assert.equal(body.p_instagram_account.tokenKind, 'user');
        assert.deepEqual(body.p_instagram_account.grantedScopes, ['instagram_basic','pages_show_list']);
        return { connections: [{ provider: 'instagram', connectionId: 'synthetic-discovery-connection' }] };
      }
      assert.fail('Discovery must not require new publishing RPCs');
    },
  });
  assert.equal(result.connections[0].connectionId, 'synthetic-discovery-connection');
});

test('publishing selection rejects missing server owner binding rather than using discovery fallback', async () => {
  const selected = await publishingSelection();
  delete selected.userId;
  assert.throws(() => commit(selected), /owner|context/i);
});
