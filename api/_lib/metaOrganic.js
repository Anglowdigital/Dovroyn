import crypto from 'node:crypto';
import { evaluateAgentAction } from './agentSafety.js';
import { getSupabaseServiceConfig, rpcWithServiceRole } from './supabaseAuth.js';

export const META_GRAPH_VERSION = 'v26.0';
export const META_PROVIDER_KEY = 'instagram';
export const META_FACEBOOK_PROVIDER_KEY = 'facebook';
export const META_PROVIDER_KEYS = Object.freeze([META_PROVIDER_KEY, META_FACEBOOK_PROVIDER_KEY]);
export const META_LOGIN_ROUTE = 'facebook_login_for_instagram_api';
// Official docs retrieved 2026-10-12:
// - Facebook Login manual flow documents server-side GET token exchange.
// - Instagram API with Facebook Login documents GET /me/accounts fields used here.
// Keep this discovery-only contract narrow and continue treating pages_manage_posts
// as pending approval.
export const META_ORGANIC_SCOPES = Object.freeze(['instagram_basic', 'pages_show_list']);
export const META_FACEBOOK_PAGE_SCOPES = Object.freeze(['pages_show_list']);
export const META_ORGANIC_CONTRACT_VERSION = 'meta_organic_facebook_login_selection_v2';
export const META_ORGANIC_PROVENANCE = 'meta_organic_server_v1';
export const META_STATE_TTL_MS = 10 * 60 * 1000;
export const META_SELECTION_TTL_MS = 10 * 60 * 1000;
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

export function buildMetaAuthorizeUrl(config, state, scopes = config.scopes) {
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(','));
  return url.toString();
}

export function buildIntegrationRedirect({ podId, status, reason, connectionId, selectionId }) {
  const url = new URL(podId ? `/pods/${encodeURIComponent(podId)}` : '/pods', appBaseUrl());
  url.searchParams.set('integration', 'meta');
  url.searchParams.set('status', status);
  if (reason && SAFE_ERROR_CODES.has(reason)) url.searchParams.set('reason', reason);
  if (connectionId) url.searchParams.set('connectionId', connectionId);
  if (selectionId) url.searchParams.set('selectionId', selectionId);
  return url.toString();
}

export function createStateRecord({
  userId,
  podId,
  redirectUri,
  requestedProviderKey = META_PROVIDER_KEY,
  requiredScopes = META_ORGANIC_SCOPES,
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
    requestedProviderKey: normalizeProviderKey(requestedProviderKey) || META_PROVIDER_KEY,
    requiredScopes: [...requiredScopes],
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
    p_requested_provider: record.requestedProviderKey,
    p_required_scopes: record.requiredScopes,
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
    p_provider: connection.provider,
    p_provider_account_id: connection.providerAccountId,
    p_account_label: connection.accountLabel,
    p_granted_scopes: connection.grantedScopes,
    p_expires_at: connection.expiresAt,
    p_encrypted_access_token: connection.encryptedAccessToken,
    p_encryption_key_version: connection.encryptionKeyVersion,
    p_token_kind: connection.tokenKind,
  });
}

export async function listMetaConnections(userId, podId, deps = {}) {
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('list_meta_organic_connections', {
    p_user_id: userId,
    p_pod_id: podId,
  });
}

export async function createPendingMetaSelection(selection, deps = {}) {
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  await rpc('create_meta_organic_pending_selection', {
    p_selection_hash: selection.selectionHash,
    p_user_id: selection.userId,
    p_pod_id: selection.podId,
    p_expires_at: selection.expiresAt,
    p_token_expires_at: selection.tokenExpiresAt,
    p_granted_scopes: selection.grantedScopes,
    p_encrypted_access_token: selection.encryptedAccessToken,
    p_encrypted_candidates: selection.encryptedCandidates,
    p_encryption_key_version: selection.encryptionKeyVersion,
  });
}

export async function loadPendingMetaSelection(selectionId, userId, podId, deps = {}) {
  const selectionHash = hashIncomingState(selectionId);
  if (!selectionHash || !userId || !podId) return null;
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('get_meta_organic_pending_selection', {
    p_selection_hash: selectionHash,
    p_user_id: userId,
    p_pod_id: podId,
  });
}

export async function consumePendingMetaSelection(selectionId, userId, podId, deps = {}) {
  const selectionHash = hashIncomingState(selectionId);
  if (!selectionHash || !userId || !podId) return null;
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('consume_meta_organic_pending_selection', {
    p_selection_hash: selectionHash,
    p_user_id: userId,
    p_pod_id: podId,
  });
}

export async function commitPendingMetaSelection(selection, deps = {}) {
  const rpc = deps.rpcWithServiceRole || rpcWithServiceRole;
  if (!deps.rpcWithServiceRole) requireServiceStorage();
  return rpc('commit_meta_organic_account_selection', {
    p_selection_hash: selection.selectionHash,
    p_user_id: selection.userId,
    p_pod_id: selection.podId,
    p_facebook_page: selection.facebookPage || null,
    p_instagram_account: selection.instagramAccount || null,
  });
}

function normalizeProviderKey(provider) {
  const key = String(provider || '').trim().toLowerCase();
  return META_PROVIDER_KEYS.includes(key) ? key : '';
}

export function authorizeMetaConnection({ pod, user, subscription, requestedProviderKey = META_PROVIDER_KEY, idempotencyKey }) {
  const trustedProviderKey = normalizeProviderKey(requestedProviderKey);
  const result = evaluateAgentAction({
    level: 'execute',
    actionType: 'connect_account',
    idempotencyKey,
    requestedProviderKey: trustedProviderKey || String(requestedProviderKey || ''),
  }, {
    approvedByHuman: true,
    providerSetupReady: true,
    trustedProviderKey,
    actionEntitled: true,
    subscription,
  });
  if (!user?.id || !pod?.id || !subscription || !result.allowed) {
    const error = new Error(result.reason || 'Meta connection is not authorized.');
    error.status = 403;
    throw error;
  }
  return { ...result, providerKey: trustedProviderKey };
}

function assertTrustedGraphUrl(url) {
  if (!(url instanceof URL) || url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') {
    throw Object.assign(new Error('Meta provider host is not trusted.'), { status: 502, code: 'provider_unavailable' });
  }
}

async function providerJson(url, options, deps = {}) {
  assertTrustedGraphUrl(url);
  const fetchImpl = deps.fetch || fetch;
  const response = await fetchImpl(url, { redirect: 'manual', ...(options || {}) });
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

async function graphOAuthGet(path, params, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  return providerJson(url, { method: 'GET' }, deps);
}

export async function exchangeCodeForUserToken(code, redirectUri, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const shortToken = await graphOAuthGet('/oauth/access_token', {
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: redirectUri,
    code,
  }, deps);
  if (!shortToken?.access_token) throw Object.assign(new Error('Meta token exchange failed.'), { status: 502, code: 'provider_unavailable' });
  const longToken = await graphOAuthGet('/oauth/access_token', {
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

export function requiredScopesForProvider(provider) {
  if (provider === META_FACEBOOK_PROVIDER_KEY) return [...META_FACEBOOK_PAGE_SCOPES];
  if (provider === META_PROVIDER_KEY) return [...META_ORGANIC_SCOPES];
  return [];
}

export function filterRequiredScopes(grantedScopes, requiredScopes) {
  validateGrantedScopes(grantedScopes, requiredScopes);
  const granted = new Set(grantedScopes || []);
  return requiredScopes.filter((scope) => granted.has(scope));
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
  const candidates = await discoverMetaAccountCandidates(accessToken, deps);
  const accounts = candidates.instagramAccounts;
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
    return {
      providerAccountId: accounts[0].id,
      accountLabel: accounts[0].label,
  };
}

export async function discoverMetaAccountCandidates(accessToken, deps = {}) {
  const pages = [];
  let after = '';
  const includeInstagram = deps.includeInstagram !== false;
  for (let page = 0; page < 10; page += 1) {
    const payload = await graphGet('/me/accounts', {
      fields: 'id,name,access_token',
      limit: 25,
      ...(after ? { after } : {}),
    }, accessToken, deps);
    for (const item of payload.data || []) {
      const pageId = sanitizeProviderAccountId(item?.id);
      if (!pageId) continue;
      const pageLabel = sanitizeAccountLabel(item?.name || pageId);
      let instagramId = '';
      if (includeInstagram) {
        const pagePayload = await graphGet(`/${pageId}`, {
          fields: 'instagram_business_account',
        }, accessToken, deps);
        instagramId = sanitizeProviderAccountId(pagePayload?.instagram_business_account?.id);
      }
      pages.push({
        id: pageId,
        label: pageLabel,
        pageAccessToken: typeof item?.access_token === 'string' ? item.access_token : '',
        instagramAccount: instagramId ? {
          id: instagramId,
          label: sanitizeAccountLabel(`${pageLabel} Instagram (${instagramId})`),
          pageId,
          pageLabel,
        } : null,
      });
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
  const instagramAccounts = pages
    .map((page) => page.instagramAccount)
    .filter(Boolean);
  if (pages.length === 0 && instagramAccounts.length === 0) {
    const error = new Error('No page-linked Instagram professional account is available.');
    error.status = 422;
    error.code = 'account_unavailable';
    throw error;
  }
  return { pages, instagramAccounts };
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

export function decryptProviderPayload(encrypted, config = getMetaOrganicConfig()) {
  const bytes = Buffer.from(String(encrypted || ''), 'base64url');
  if (bytes.length <= 28) throw new Error('Invalid encrypted provider payload.');
  const key = decodeEncryptionKey(config.encryptionKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

export function createSelectionRecord({
  userId,
  podId,
  token,
  tokenExpiresAt,
  grantedScopes,
  candidates,
  now = Date.now(),
  random = randomToken,
  config = getMetaOrganicConfig(),
  encrypt = encryptProviderToken,
} = {}) {
  if (!userId || !podId || !token || !tokenExpiresAt || !candidates) throw new Error('Pending Meta selection requires user, pod, token and candidates.');
  const selectionId = random();
  if (!STATE_PATTERN.test(selectionId)) throw new Error('Generated Meta selection id is invalid.');
  return {
    selectionId,
    selectionHash: sha256Hex(selectionId),
    userId,
    podId,
    expiresAt: new Date(now + META_SELECTION_TTL_MS).toISOString(),
    tokenExpiresAt,
    grantedScopes,
    encryptedAccessToken: encrypt(token, config),
    encryptedCandidates: encrypt(JSON.stringify(sanitizeMetaCandidates(candidates, { includeCredentials: true })), config),
    encryptionKeyVersion: config.encryptionKeyVersion,
  };
}

export function decryptPendingCandidates(record, config = getMetaOrganicConfig(), decrypt = decryptProviderPayload) {
  const raw = decrypt(record?.encrypted_candidates || record?.encryptedCandidates, config);
  const parsed = JSON.parse(raw);
  return sanitizeMetaCandidates(parsed, { includeCredentials: true });
}

export function sanitizeProviderAccountId(value) {
  const id = String(value || '').trim();
  return /^[1-9][0-9]{0,31}$/.test(id) ? id : '';
}

export function sanitizeAccountLabel(label) {
  const cleaned = String(label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 120) || 'Instagram account';
}

export function sanitizeMetaCandidates(candidates = {}, { includeCredentials = false } = {}) {
  const pages = [];
  const seenPages = new Set();
  for (const item of candidates.pages || []) {
    const id = sanitizeProviderAccountId(item?.id);
    if (!id || seenPages.has(id)) continue;
    seenPages.add(id);
    const page = { id, label: sanitizeAccountLabel(item.label) };
    if (typeof item.pageCredentialAvailable === 'boolean') page.pageCredentialAvailable = item.pageCredentialAvailable;
    if (includeCredentials && typeof item.pageAccessToken === 'string' && item.pageAccessToken) {
      page.pageAccessToken = item.pageAccessToken;
      page.pageCredentialAvailable = true;
    }
    const instagramId = sanitizeProviderAccountId(item.instagramAccount?.id);
    if (instagramId) {
      page.instagramAccount = {
        id: instagramId,
        label: sanitizeAccountLabel(item.instagramAccount.label),
        pageId: id,
        pageLabel: page.label,
      };
    }
    pages.push(page);
  }
  return {
    pages,
    instagramAccounts: pages.map((page) => page.instagramAccount).filter(Boolean),
  };
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

function findSelectedCandidate(candidates, { selectedFacebookPageId, selectedInstagramAccountId }) {
  const facebookPageId = sanitizeProviderAccountId(selectedFacebookPageId);
  const instagramAccountId = sanitizeProviderAccountId(selectedInstagramAccountId);
  if (!facebookPageId && !instagramAccountId) {
    const error = new Error('Choose a Facebook Page or Instagram account.');
    error.status = 400;
    error.code = 'account_unavailable';
    throw error;
  }
  const page = facebookPageId ? candidates.pages.find((item) => item.id === facebookPageId) : null;
  if (facebookPageId && !page) {
    const error = new Error('Selected Facebook Page is not eligible.');
    error.status = 403;
    error.code = 'account_unavailable';
    throw error;
  }
  const instagram = instagramAccountId ? candidates.instagramAccounts.find((item) => item.id === instagramAccountId) : null;
  if (instagramAccountId && !instagram) {
    const error = new Error('Selected Instagram account is not eligible.');
    error.status = 403;
    error.code = 'account_unavailable';
    throw error;
  }
  if (page && instagram && instagram.pageId !== page.id) {
    const error = new Error('Selected Instagram account is not linked to the selected Facebook Page.');
    error.status = 403;
    error.code = 'account_unavailable';
    throw error;
  }
  return { page, instagram };
}

export function serializeMetaSelectionForClient(selectionId, candidates) {
  return {
    selectionId,
    pages: candidates.pages.map((page) => ({
      id: page.id,
      label: page.label,
      pageCredentialAvailable: Boolean(page.pageAccessToken || page.pageCredentialAvailable),
      instagramAccount: page.instagramAccount ? {
        id: page.instagramAccount.id,
        label: page.instagramAccount.label,
        pageId: page.id,
      } : null,
    })),
    instagramAccounts: candidates.instagramAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      pageId: account.pageId,
      pageLabel: account.pageLabel,
    })),
  };
}

export function buildAtomicSelectionCommit({
  selectionId,
  userId,
  podId,
  record,
  selectedFacebookPageId,
  selectedInstagramAccountId,
  config = getMetaOrganicConfig(),
  decrypt = decryptProviderPayload,
  encrypt = encryptProviderToken,
} = {}) {
  const candidates = decryptPendingCandidates(record, config, decrypt);
  const selected = findSelectedCandidate(candidates, { selectedFacebookPageId, selectedInstagramAccountId });
  const userAccessToken = decrypt(record.encrypted_access_token || record.encryptedAccessToken, config);
  const grantedScopes = record.granted_scopes || record.grantedScopes || [];
  const expiresAt = record.token_expires_at || record.tokenExpiresAt;
  const selectionHash = hashIncomingState(selectionId);
  if (!selectionHash) {
    const error = new Error('Meta account selection is unavailable or expired.');
    error.status = 404;
    error.code = 'expired_state';
    throw error;
  }
  const facebookRequired = requiredScopesForProvider(META_FACEBOOK_PROVIDER_KEY);
  const instagramRequired = requiredScopesForProvider(META_PROVIDER_KEY);
  if (selected.page && !selected.page.pageAccessToken) {
    const error = new Error('Selected Facebook Page did not return a Page credential. Choose Instagram only or reconnect Meta.');
    error.status = 422;
    error.code = 'account_unavailable';
    throw error;
  }
  return {
    selectionHash,
    userId,
    podId,
    facebookPage: selected.page ? {
      provider: META_FACEBOOK_PROVIDER_KEY,
      providerAccountId: selected.page.id,
      accountLabel: selected.page.label,
      grantedScopes: filterRequiredScopes(grantedScopes, facebookRequired),
      expiresAt,
      tokenKind: 'page',
      encryptedAccessToken: encrypt(selected.page.pageAccessToken, config),
      encryptionKeyVersion: config.encryptionKeyVersion,
    } : null,
    instagramAccount: selected.instagram ? {
      provider: META_PROVIDER_KEY,
      providerAccountId: selected.instagram.id,
      accountLabel: selected.instagram.label,
      linkedFacebookPageId: selected.instagram.pageId,
      grantedScopes: filterRequiredScopes(grantedScopes, instagramRequired),
      expiresAt,
      tokenKind: 'user',
      encryptedAccessToken: encrypt(userAccessToken, config),
      encryptionKeyVersion: config.encryptionKeyVersion,
    } : null,
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
    const requestedProvider = normalizeProviderKey(consumed.requested_provider || consumed.requestedProvider) || META_PROVIDER_KEY;
    const trustedRequiredScopes = Array.isArray(consumed.required_scopes || consumed.requiredScopes)
      ? (consumed.required_scopes || consumed.requiredScopes)
      : requiredScopesForProvider(requestedProvider);
    const token = await exchangeCodeForUserToken(code, consumed.redirect_uri, deps);
    const grantedScopes = await loadGrantedScopes(token.accessToken, deps);
    const filteredScopes = filterRequiredScopes(grantedScopes, trustedRequiredScopes);
    const candidates = await discoverMetaAccountCandidates(token.accessToken, {
      ...deps,
      includeInstagram: trustedRequiredScopes.includes('instagram_basic'),
    });
    const selectionRecord = createSelectionRecord({
      userId: consumed.user_id,
      podId: consumed.pod_id,
      token: token.accessToken,
      tokenExpiresAt: token.expiresAt,
      grantedScopes: filteredScopes,
      candidates,
      config,
      encrypt: deps.encryptProviderToken || encryptProviderToken,
    });
    await createPendingMetaSelection(selectionRecord, deps);
    return {
      podId: consumed.pod_id,
      selectionId: selectionRecord.selectionId,
      selectionRequired: true,
      candidates: serializeMetaSelectionForClient(selectionRecord.selectionId, candidates),
    };
  } catch (error) {
    throwWithPodContext(error, consumed.pod_id);
  }
}

export async function getMetaSelectionForClient({ selectionId, userId, podId }, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const record = await loadPendingMetaSelection(selectionId, userId, podId, deps);
  if (!record?.encrypted_candidates && !record?.encryptedCandidates) {
    const error = new Error('Meta account selection is unavailable or expired.');
    error.status = 404;
    error.code = 'expired_state';
    throw error;
  }
  const candidates = decryptPendingCandidates(record, config, deps.decryptProviderPayload || decryptProviderPayload);
  return serializeMetaSelectionForClient(selectionId, candidates);
}

export async function selectMetaAccounts({ selectionId, userId, podId, selectedFacebookPageId, selectedInstagramAccountId }, deps = {}) {
  const config = deps.config || getMetaOrganicConfig();
  const record = await loadPendingMetaSelection(selectionId, userId, podId, deps);
  if (!record?.encrypted_access_token && !record?.encryptedAccessToken) {
    const error = new Error('Meta account selection is unavailable or expired.');
    error.status = 404;
    error.code = 'expired_state';
    throw error;
  }
  const commit = buildAtomicSelectionCommit({
    selectionId,
    userId,
    podId,
    record,
    selectedFacebookPageId,
    selectedInstagramAccountId,
    config,
    decrypt: deps.decryptProviderPayload || decryptProviderPayload,
    encrypt: deps.encryptProviderToken || encryptProviderToken,
  });
  const stored = await commitPendingMetaSelection(commit, deps);
  if (!stored || !Array.isArray(stored.connections) || stored.connections.length === 0) {
    const error = new Error('Meta account selection is unavailable or expired.');
    error.status = 409;
    error.code = 'expired_state';
    throw error;
  }
  return { podId, connections: stored.connections };
}
