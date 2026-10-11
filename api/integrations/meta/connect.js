import { getBearerToken, readJsonBody, requirePost, sendJson } from '../../_lib/http.js';
import { loadActiveSubscription, loadOwnedPod, verifySupabaseUser } from '../../_lib/supabaseAuth.js';
import {
  assertProviderSetupReady,
  authorizeMetaConnection,
  buildMetaAuthorizeUrl,
  createOAuthState,
  createStateRecord,
  getMetaOrganicConfig,
  META_LOGIN_ROUTE,
  META_ORGANIC_SCOPES,
  META_PROVIDER_KEY,
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
    assertProviderSetupReady(config);

    const user = await verifySupabaseUser(accessToken);
    if (!user?.id) return sendJson(res, 401, { error: 'Sign in before connecting Meta.' });

    const [pod, subscription] = await Promise.all([
      loadOwnedPod(accessToken, podId),
      loadActiveSubscription(accessToken, user.id),
    ]);
    authorizeMetaConnection({
      pod,
      user,
      subscription,
      requestedProviderKey: body.providerKey || META_PROVIDER_KEY,
      idempotencyKey,
    });

    const stateRecord = createStateRecord({ userId: user.id, podId, redirectUri: config.redirectUri });
    await createOAuthState(stateRecord);

    return sendJson(res, 200, {
      authorizationUrl: buildMetaAuthorizeUrl(config, stateRecord.state),
      provider: META_PROVIDER_KEY,
      loginRoute: META_LOGIN_ROUTE,
      requiredScopes: META_ORGANIC_SCOPES,
      expiresAt: stateRecord.expiresAt,
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    const safeStatus = status >= 400 && status < 500 ? status : 503;
    return sendJson(res, safeStatus, { error: safeStatus === 503 ? 'Meta connection is unavailable.' : error.message });
  }
}
