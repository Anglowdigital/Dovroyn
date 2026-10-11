import crypto from 'node:crypto';
import { evaluateAgentAction } from './agentSafety.js';
import { getSupabaseServiceConfig, rpcWithServiceRole } from './supabaseAuth.js';

export const META_GRAPH_VERSION = 'v26.0';
export const META_PROVIDER_KEY = 'instagram';
export const META_LOGIN_ROUTE = 'facebook_login_for_instagram_api';
// Official scope verification was attempted against Meta docs during this task,
// but developers.facebook.com returned 429 to the tool. Keep this discovery-only
// contract narrow and continue treating pages_manage_posts as pending approval.
export const META_ORGANIC_SCOPES = Object.freeze(['instagram_basic', 'pages_show_list']);
export const META_ORGANIC_CONTRACT_VERSION = 'meta_organic_facebook_login_v1';
export const META_ORGANIC_PROVENANCE = 'meta_organic_server_v1';
export const META_STATE_TTL_MS = 10 * 60 * 1000;
export const META_OAUTH_COOKIE = 'dovroyn_meta_oauth';

const STATE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const COOKIE_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SAFE_ERROR_CODES = new Set([
  'access_denied',
  'account_ambiguous',
  'account_unavailable',
  'configuration_required',
  'connection_unavailable',
  'csrf_failed',
  'expired_state',
  'missing_scope',
  'provider_unavailable',
  'storage_unavailable',
]);

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function appBaseUrl() {
  return safeUrl(process.env.DOVROYN_APP_URL || process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) || 'https://dovroyn.com')
    || 'https://dovroyn.com';
}

export function getMetaOrganicConfig(env = process.env) {
  const appId = String(env.META_APP_ID || env.META_CLIENT_ID || '').trim();
  const appSecret = String(env.META_APP_SECRET || env.META_CLIENT_SECRET || '').trim();
  const redirectUri = safeUrl(env.META_OAUTH_REDIRECT_URI || env.META_REDIRECT_URI || 'https://dovroyn.com/api/integrations/callback');
  const graphVersion = String(env.META_GRAPH_VERSION || META_GRAPH_VERSION).replace(/^\/+/, '');
  const encryptionKey = String(env.META_TOKEN_ENCRYPTION_KEY || '').trim();
  const encryptionKeyVersion = String(env.META_TOKEN_ENCRYPTION_KEY_VERSION || '').trim();
  const cookieSecret = String(env.META_OAUTH_COOKIE_SECRET || encryptionKey || '').trim();
  const activationEnabled = env.META_ORGANIC_CONNECTIONS_ENABLED === 'true';
  const configured = Boolean(appId && appSecret && redirectUri && encryptionKey && encryptionKeyVersion && cookieSecret);
  return {
    appId,
    appSecret,
    redirectUri,
    graphVersion,
    encryptionKey,
    encryptionKeyVersion,
    cookieSecret,
    activationEnabled,
    configured,
    scopes: [...META_ORGANIC_SCOPES],
    loginRoute: META_LOGIN_ROUTE,
    contractVersion: META_ORGANIC_CONTRACT_VERSION,
  };
}

export function buildMetaAuthorizeUrl(config, state) {
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes.join(','));
  return url.toString();
}

export function buildIntegrationRedirect({ podId, status, reason, connectionId }) {
  const url = new URL(podId ? `/pods/${encodeURIComponent(podId)}` : '/pods', appBaseUrl());
  url.searchParams.set('integration', 'meta');
  url.searchParams.set('status', status);
  if (reason && SAFE_ERROR_CODES.has(reason)) url.searchParams.set('reason', reason);
  if (connectionId) url.searchParams.set('connectionId', connectionId);
  return url.toString();
}

export function createStateRecord({
  userId,
  podId,
  redirectUri,
  now = Date.now(),
  random = randomToken,
} = {}) {
  if (!userId || !podId || !redirectUri) throw new Error('OAuth state requires user, pod and redirect URI.');
  const state = random();
  const browserNonce = random();
  if (!STATE_PATTERN.test(state) || !COOKIE_NONCE_PATTERN.test(browserNonce)) throw new Error('Generated OAuth state is invalid.');
  return {
    state,
    stateHash: sha256Hex(state),
    browserNonce,
    browserBindingHash: sha256Hex(browserNonce),
    userId,
    podId,
    redirectUri,
    expiresAt: new Date(now + META_STATE_TTL_MS).toISOString(),
    expiresUnix: Math.floor((now + META_STATE_TTL_MS) / 1000),
  };
}

export function hashIncomingState(state) {
  const normalized = String(state || '').trim();
  if (!STATE_PATTERN.test(normalized)) return '';
  return sha256Hex(normalized);
}

export function buildOAuthCookie(record, config = getMetaOrganicConfig()) {
  const payload = `${record.stateHash}.${record.browserNonce}.${record.expiresUnix}`;
  const signature = hmac(payload, config.cookieSecret);
  return `${META_OAUTH_COOKIE}=v1.${record.browserNonce}.${record.expiresUnix}.${signature}; Max-Age=${Math.ceil(META_STATE_TTL_MS / 1000)}; Path=/api/integrations/callback; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOAuthCookie() {
  return `${META_OAUTH_COOKIE}=; Max-Age=0; Path=/api/integrations/callback; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
    }));
}

export function validateOAuthCookie({ cookieHeader, state, now = Date.now(), config = getMetaOrganicConfig() }) {
  const stateHash = hashIncomingState(state);
  if (!stateHash) return null;
  const value = parseCookies(cookieHeader)[META_OAUTH_COOKIE] || '';
  const [version, browserNonce, expiresUnixRaw, signature] = value.split('.');
  const expiresUnix = Number(expiresUnixRaw);
  if (version !== 'v1' || !COOKIE_NONCE_PATTERN.test(browserNonce) || !Number.isInteger(expiresUnix) || !signature) return null;
  if (expiresUnix * 1000 <= now) return null;
  const payload = `${stateHash}.${browserNonce}.${expiresUnix}`;
  const expected = hmac(payload, config.cookieSecret);
  if (!timingSafeEqual(signature, expected)) return null;
  return { stateHash, browserBindingHash: sha256Hex(browserNonce) };
}

function requireServiceStorage() {
  getSupabaseServiceConfig();
}

function readinessError(message = 'Meta connection storage is not ready.') {
  const error = new Error(message);
  error.status = 503;
  error.code = 'storage_unavailable';
  return error;
}

export function assertProviderSetupReady(config = getMetaOrganicConfig()) {
  if (!config.configured) {
    const error = new Error('Meta connection is not configured.');
    error.status = 503;
    error.code = 'configuration_required';
    throw error;
  }
  if (!config.activationEnabled) throw readinessError('Meta connection cutover has not been enabled.');
}

function validReadiness(payload, config) {
  return payload?.ready === true
    && payload.contract_version === config.contractVersion
    && payload.provider_verified_source === META_ORGANIC_PROVENANCE
    && Array.isArray(payload.required_scopes)
    && config.scopes.every((scope) => payload.required_scopes.includes(scope));
}

export async function loadMetaOrganicReadiness(config = getMetaOrganicConfig(), deps = {}) {
  if (!config.configured || !config.activationEnabled) return { ready: false, reason: 'configuration_required' };
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  try {
    const payload = await rpc('get_meta_organic_connection_readiness', {});
    return validReadiness(payload, config) ? { ready: true, contractVersion: payload.contract_version }
      : { ready: false, reason: 'storage_unavailable' };
  } catch {
    return { ready: false, reason: 'storage_unavailable' };
  }
}

export async function assertMetaOrganicReady(config = getMetaOrganicConfig(), deps = {}) {
  assertProviderSetupReady(config);
  const readiness = await loadMetaOrganicReadiness(config, deps);
  if (!readiness.ready) throw readinessError();
  return readiness;
}

export async function createOAuthState(record, deps = {}) {
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  await rpc('create_meta_organic_oauth_state', {
    p_state_hash: record.stateHash,
    p_browser_binding_hash: record.browserBindingHash,
    p_user_id: record.userId,
    p_pod_id: record.podId,
    p_redirect_uri: record.redirectUri,
    p_expires_at: record.expiresAt,
  });
}

export async function consumeOAuthState(state, browserBindingHash, deps = {}) {
  const stateHash = hashIncomingState(state);
  if (!stateHash || !browserBindingHash) return null;
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('consume_meta_organic_oauth_state', {
    p_state_hash: stateHash,
    p_browser_binding_hash: browserBindingHash,
  });
}

export async function storeMetaConnection(connection, deps = {}) {
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('store_meta_organic_connection', {
    p_user_id: connection.userId,
    p_pod_id: connection.podId,
    p_provider_account_id: connection.providerAccountId,
    p_account_label: connection.accountLabel,
    p_granted_scopes: connection.grantedScopes,
    p_expires_at: connection.expiresAt,
    p_encrypted_access_token: connection.encryptedAccessToken,
    p_encryption_key_version: connection.encryptionKeyVersion,
  });
}

export function authorizeMetaConnection({ pod, user, subscription, requestedProviderKey = META_PROVIDER_KEY, idempotencyKey }) {
  const result = evaluateAgentAction({
    level: 'execute',
    actionType: 'connect_account',
    idempotencyKey,
    requestedProviderKey,
  }, {
    approvedByHuman: true,
    providerSetupReady: true,
    trustedProviderKey: META_PROVIDER_KEY,
    actionEntitled: true,
    subscription,
  });
  if (!user?.id || !pod?.id || !subscription || !result.allowed) {
    const error = new Error(result.reason || 'Meta connection is not authorized.');
    error.status = 403;
    throw error;
  }
  return result;
}

async function providerJson(url, options, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const response = await fetchImpl(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Meta provider request failed.');
    error.status = 502;
    error.code = 'provider_unavailable';
    error.providerStatus = response.status;
    throw error;
  }
  return payload;
}

async function graphGet(path, params, token, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  return providerJson(url, { headers: { Authorization: `Bearer ${token}` } }, deps);
}

async function graphPostForm(path, params, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}${path}`);
  const body = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) body.set(key, value);
  });
  return providerJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, deps);
}

export async function exchangeCodeForUserToken(code, redirectUri, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const shortToken = await graphPostForm('/oauth/access_token', {
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: redirectUri,
    code,
  }, deps);
  if (!shortToken?.access_token) throw Object.assign(new Error('Meta token exchange failed.'), { status: 502, code: 'provider_unavailable' });
  const longToken = await graphPostForm('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortToken.access_token,
  }, deps);
  const accessToken = longToken?.access_token || shortToken.access_token;
  const expiresIn = Number(longToken?.expires_in || shortToken?.expires_in || 0);
  return {
    accessToken,
    expiresAt: new Date(Date.now() + Math.max(expiresIn, 60) * 1000).toISOString(),
  };
}

export async function loadGrantedScopes(accessToken, deps = {}) {
  const payload = await graphGet('/me/permissions', {}, accessToken, deps);
  return (payload.data || [])
    .filter((item) => item?.status === 'granted' && typeof item.permission === 'string')
    .map((item) => item.permission);
}

export function validateGrantedScopes(grantedScopes, requiredScopes = META_ORGANIC_SCOPES) {
  const granted = new Set(grantedScopes || []);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length) {
    const error = new Error('Required Meta permissions were not granted.');
    error.status = 403;
    error.code = 'missing_scope';
    error.missingScopes = missing;
    throw error;
  }
}

function nextAfter(payload) {
  const next = payload?.paging?.next;
  if (!next) return '';
  try {
    return new URL(next).searchParams.get('after') || '';
  } catch {
    return '';
  }
}

export async function loadInstagramAccount(accessToken, deps = {}) {
  const accounts = [];
  let after = '';
  for (let page = 0; page < 10; page += 1) {
    const payload = await graphGet('/me/accounts', {
      fields: 'id,name,instagram_business_account{id,username,name}',
      limit: 25,
      ...(after ? { after } : {}),
    }, accessToken, deps);
    for (const item of payload.data || []) {
      if (item?.instagram_business_account?.id) accounts.push({ page: item, instagram: item.instagram_business_account });
    }
    after = nextAfter(payload);
    if (!after) break;
  }
  if (after) {
    const error = new Error('Unable to safely enumerate all linked Instagram professional accounts.');
    error.status = 409;
    error.code = 'account_ambiguous';
    throw error;
  }
  if (accounts.length === 0) {
    const error = new Error('No page-linked Instagram professional account is available.');
    error.status = 422;
    error.code = 'account_unavailable';
    throw error;
  }
  if (accounts.length > 1) {
    const error = new Error('Multiple Instagram professional accounts are available. Choose one before connecting.');
    error.status = 409;
    error.code = 'account_ambiguous';
    throw error;
  }
  const { page, instagram } = accounts[0];
  return {
    providerAccountId: String(instagram.id),
    accountLabel: sanitizeAccountLabel(instagram.username || instagram.name || page.name || String(instagram.id)),
  };
}

function decodeEncryptionKey(raw) {
  const value = String(raw || '').trim();
  const hex = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : null;
  const decoded = hex || Buffer.from(value, 'base64url');
  if (decoded.length !== 32) throw new Error('Invalid token encryption key.');
  return decoded;
}

export function encryptProviderToken(token, config = getMetaOrganicConfig(), iv = crypto.randomBytes(12)) {
  const key = decodeEncryptionKey(config.encryptionKey);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return base64url(Buffer.concat([iv, tag, ciphertext]));
}

export function sanitizeAccountLabel(label) {
  const cleaned = String(label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 120) || 'Instagram account';
}

export function normalizeConnection(connection, now = Date.now()) {
  const expiresAt = connection.expiresAt || connection.expires_at || null;
  const rawStatus = String(connection.status || 'error');
  const expiresMillis = Date.parse(expiresAt);
  const hasValidFutureExpiry = Boolean(expiresAt) && Number.isFinite(expiresMillis) && expiresMillis > now;
  const provenance = connection.providerVerifiedSource || connection.provider_verified_source || null;
  const contractVersion = connection.providerContractVersion || connection.provider_contract_version || null;
  const hasVerifiedProvenance = provenance === META_ORGANIC_PROVENANCE && contractVersion === META_ORGANIC_CONTRACT_VERSION;
  const status = rawStatus === 'connected'
    ? (!hasVerifiedProvenance ? 'reconnect_required' : (!hasValidFutureExpiry ? 'expired' : 'connected'))
    : rawStatus;
  return {
    id: connection.id,
    provider: connection.provider,
    providerAccountId: connection.providerAccountId || connection.provider_account_id || null,
    accountLabel: sanitizeAccountLabel(connection.accountLabel || connection.account_label),
    status,
    grantedScopes: Array.isArray(connection.grantedScopes) ? connection.grantedScopes : (connection.granted_scopes || []),
    connectedAt: connection.connectedAt || connection.connected_at || null,
    expiresAt,
    updatedAt: connection.updatedAt || connection.updated_at || null,
    providerVerifiedSource: provenance,
    providerContractVersion: contractVersion,
  };
}

function throwWithPodContext(error, podId) {
  if (podId && error && typeof error === 'object' && !error.podId) error.podId = podId;
  throw error;
}

export async function completeMetaCallback({ code, state, errorCode, cookieHeader }, deps = {}) {
  if (errorCode) throw Object.assign(new Error('Meta authorization was denied.'), { status: 403, code: 'access_denied' });
  if (!code || !state) throw Object.assign(new Error('Missing OAuth callback parameters.'), { status: 400, code: 'csrf_failed' });
  const config = deps.config || getMetaOrganicConfig();
  assertProviderSetupReady(config);
  const binding = validateOAuthCookie({ cookieHeader, state, config });
  if (!binding) throw Object.assign(new Error('OAuth browser binding is invalid or expired.'), { status: 403, code: 'csrf_failed' });
  const consumed = await consumeOAuthState(state, binding.browserBindingHash, deps);
  if (!consumed?.user_id || !consumed?.pod_id || consumed.redirect_uri !== config.redirectUri) {
    throw Object.assign(new Error('OAuth state is invalid or expired.'), { status: 403, code: 'expired_state' });
  }
  try {
    const token = await exchangeCodeForUserToken(code, consumed.redirect_uri, deps);
    const grantedScopes = await loadGrantedScopes(token.accessToken, deps);
    validateGrantedScopes(grantedScopes, config.scopes);
    const account = await loadInstagramAccount(token.accessToken, deps);
    const encryptedAccessToken = (deps.encryptProviderToken || encryptProviderToken)(token.accessToken, config);
    const connectionId = await storeMetaConnection({
      userId: consumed.user_id,
      podId: consumed.pod_id,
      providerAccountId: account.providerAccountId,
      accountLabel: account.accountLabel,
      grantedScopes,
      expiresAt: token.expiresAt,
      encryptedAccessToken,
      encryptionKeyVersion: config.encryptionKeyVersion,
    }, deps);
    return { podId: consumed.pod_id, connectionId, accountLabel: account.accountLabel, grantedScopes };
  } catch (error) {
    throwWithPodContext(error, consumed.pod_id);
  }
}
