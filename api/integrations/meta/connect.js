import { getBearerToken, readJsonBody, requirePost, sendJson } from '../../_lib/http.js';
import { loadActiveSubscription, loadOwnedPod, verifySupabaseUser } from '../../_lib/supabaseAuth.js';
import {
  assertMetaOrganicReady,
  authorizeMetaConnection,
  buildOAuthCookie,
  buildMetaAuthorizeUrl,
  createOAuthState,
  createStateRecord,
  getMetaOrganicConfig,
  META_LOGIN_ROUTE,
  META_PROVIDER_KEY,
  requiredScopesForProvider,
} from '../../_lib/metaOrganic.js';

export default async function handler(req, res) {
  if (!requirePost(req, res)) return;
  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) return sendJson(res, 401, { error: 'Sign in before connecting Meta.' });

    const body = readJsonBody(req);
    const podId = String(body.podId || '').trim();
    const idempotencyKey = String(body.idempotencyKey || '').trim();
    if (!podId) return sendJson(res, 400, { error: 'Choose a pod before connecting Meta.' });

    const config = getMetaOrganicConfig();
    await assertMetaOrganicReady(config);

    const user = await verifySupabaseUser(accessToken);
    if (!user?.id) return sendJson(res, 401, { error: 'Sign in before connecting Meta.' });

    const [pod, subscription] = await Promise.all([
      loadOwnedPod(accessToken, podId),
      loadActiveSubscription(accessToken, user.id),
    ]);
    const authorization = authorizeMetaConnection({
      pod,
      user,
      subscription,
      requestedProviderKey: body.providerKey || META_PROVIDER_KEY,
      idempotencyKey,
    });

    const requiredScopes = requiredScopesForProvider(authorization.providerKey || META_PROVIDER_KEY);
    const stateRecord = createStateRecord({
      userId: user.id,
      podId,
      redirectUri: config.redirectUri,
      requestedProviderKey: authorization.providerKey,
      requiredScopes,
    });
    await createOAuthState(stateRecord);
    res.setHeader('Set-Cookie', buildOAuthCookie(stateRecord, config));

    return sendJson(res, 200, {
      authorizationUrl: buildMetaAuthorizeUrl(config, stateRecord.state, requiredScopes),
      provider: authorization.providerKey || META_PROVIDER_KEY,
      loginRoute: META_LOGIN_ROUTE,
      requiredScopes,
      expiresAt: stateRecord.expiresAt,
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    const safeStatus = status >= 400 && status < 500 ? status : 503;
    return sendJson(res, safeStatus, { error: safeStatus === 503 ? 'Meta connection is unavailable.' : error.message });
  }
}
