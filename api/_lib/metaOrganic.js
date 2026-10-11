import crypto from 'node:crypto';
import { evaluateAgentAction } from './agentSafety.js';
import { getSupabaseServiceConfig, rpcWithServiceRole } from './supabaseAuth.js';

export const META_GRAPH_VERSION = 'v26.0';
export const META_PROVIDER_KEY = 'instagram';
export const META_LOGIN_ROUTE = 'facebook_login_for_instagram_api';
// Meta's Instagram API with Facebook Login is the route that fits the supplied
// page-linked Instagram business evidence. Keep this read/connect foundation to
// its least-privilege discovery scopes; publishing scopes remain out of scope.
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started
export const META_ORGANIC_SCOPES = Object.freeze(['instagram_basic', 'pages_show_list']);
export const META_STATE_TTL_MS = 10 * 60 * 1000;

const STATE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const SAFE_ERROR_CODES = new Set([
  'access_denied',
  'configuration_required',
  'connection_unavailable',
  'csrf_failed',
  'expired_state',
  'missing_scope',
  'provider_unavailable',
  'account_unavailable',
]);

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomState() {
  return crypto.randomBytes(32).toString('base64url');
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
  return safeUrl(process.env.DOVROYN_APP_URL || process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` || 'https://dovroyn.com')
    || 'https://dovroyn.com';
}

export function getMetaOrganicConfig(env = process.env) {
  const appId = String(env.META_APP_ID || env.META_CLIENT_ID || '').trim();
  const appSecret = String(env.META_APP_SECRET || env.META_CLIENT_SECRET || '').trim();
  const redirectUri = safeUrl(env.META_OAUTH_REDIRECT_URI || env.META_REDIRECT_URI || 'https://dovroyn.com/api/integrations/callback');
  const graphVersion = String(env.META_GRAPH_VERSION || META_GRAPH_VERSION).replace(/^\/+/, '');
  const encryptionKey = String(env.META_TOKEN_ENCRYPTION_KEY || '').trim();
  const encryptionKeyVersion = String(env.META_TOKEN_ENCRYPTION_KEY_VERSION || '').trim();
  const configured = Boolean(appId && appSecret && redirectUri && encryptionKey && encryptionKeyVersion);
  return {
    appId,
    appSecret,
    redirectUri,
    graphVersion,
    encryptionKey,
    encryptionKeyVersion,
    configured,
    scopes: [...META_ORGANIC_SCOPES],
    loginRoute: META_LOGIN_ROUTE,
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
  const url = new URL('/pods', appBaseUrl());
  if (podId) url.searchParams.set('podId', podId);
  url.searchParams.set('integration', 'meta');
  url.searchParams.set('status', status);
  if (reason && SAFE_ERROR_CODES.has(reason)) url.searchParams.set('reason', reason);
  if (connectionId) url.searchParams.set('connectionId', connectionId);
  return url.toString();
}

export function createStateRecord({ userId, podId, redirectUri, now = Date.now(), random = randomState } = {}) {
  if (!userId || !podId || !redirectUri) throw new Error('OAuth state requires user, pod and redirect URI.');
  const state = random();
  if (!STATE_PATTERN.test(state)) throw new Error('Generated OAuth state is invalid.');
  return {
    state,
    stateHash: sha256Hex(state),
    userId,
    podId,
    redirectUri,
    expiresAt: new Date(now + META_STATE_TTL_MS).toISOString(),
  };
}

export function hashIncomingState(state) {
  const normalized = String(state || '').trim();
  if (!STATE_PATTERN.test(normalized)) return '';
  return sha256Hex(normalized);
}

function requireServiceStorage() {
  getSupabaseServiceConfig();
}

export async function createOAuthState(record, deps = {}) {
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  await rpc('create_instagram_oauth_state', {
    p_state_hash: record.stateHash,
    p_user_id: record.userId,
    p_pod_id: record.podId,
    p_redirect_uri: record.redirectUri,
    p_expires_at: record.expiresAt,
  });
}

export async function consumeOAuthState(state, deps = {}) {
  const stateHash = hashIncomingState(state);
  if (!stateHash) return null;
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('consume_instagram_oauth_state', { p_state_hash: stateHash });
}

export async function storeMetaConnection(connection, deps = {}) {
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('store_instagram_connection', {
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

export function assertProviderSetupReady(config = getMetaOrganicConfig()) {
  if (!config.configured) {
    const error = new Error('Meta connection is not configured.');
    error.status = 503;
    error.code = 'configuration_required';
    throw error;
  }
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

async function graphJson(path, params, token, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const config = deps.config || getMetaOrganicConfig();
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  if (token) url.searchParams.set('access_token', token);
  const response = await fetchImpl(url);
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

export async function exchangeCodeForUserToken(code, redirectUri, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const shortToken = await graphJson('/oauth/access_token', {
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: redirectUri,
    code,
  }, null, deps);
  if (!shortToken?.access_token) throw Object.assign(new Error('Meta token exchange failed.'), { status: 502, code: 'provider_unavailable' });
  const longToken = await graphJson('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortToken.access_token,
  }, null, deps);
  const accessToken = longToken?.access_token || shortToken.access_token;
  const expiresIn = Number(longToken?.expires_in || shortToken?.expires_in || 0);
  return {
    accessToken,
    expiresAt: new Date(Date.now() + Math.max(expiresIn, 60) * 1000).toISOString(),
  };
}

export async function loadGrantedScopes(accessToken, deps = {}) {
  const payload = await graphJson('/me/permissions', {}, accessToken, deps);
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

export async function loadInstagramAccount(accessToken, deps = {}) {
  const payload = await graphJson('/me/accounts', {
    fields: 'id,name,instagram_business_account{id,username,name}',
    limit: 25,
  }, accessToken, deps);
  const page = (payload.data || []).find((item) => item?.instagram_business_account?.id);
  if (!page) {
    const error = new Error('No page-linked Instagram professional account is available.');
    error.status = 422;
    error.code = 'account_unavailable';
    throw error;
  }
  const instagram = page.instagram_business_account;
  return {
    providerAccountId: String(instagram.id),
    accountLabel: instagram.username || instagram.name || page.name || String(instagram.id),
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

export async function completeMetaCallback({ code, state, errorCode }, deps = {}) {
  if (errorCode) throw Object.assign(new Error('Meta authorization was denied.'), { status: 403, code: 'access_denied' });
  if (!code || !state) throw Object.assign(new Error('Missing OAuth callback parameters.'), { status: 400, code: 'csrf_failed' });
  const config = deps.config || getMetaOrganicConfig();
  assertProviderSetupReady(config);
  const consumed = await consumeOAuthState(state, deps);
  if (!consumed?.user_id || !consumed?.pod_id || consumed.redirect_uri !== config.redirectUri) {
    throw Object.assign(new Error('OAuth state is invalid or expired.'), { status: 403, code: 'expired_state' });
  }
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
}
