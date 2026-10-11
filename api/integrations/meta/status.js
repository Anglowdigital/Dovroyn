import { getBearerToken, sendJson } from '../../_lib/http.js';
import { loadOwnedPod, loadSocialConnections, verifySupabaseUser } from '../../_lib/supabaseAuth.js';
import { META_PROVIDER_KEY } from '../../_lib/metaOrganic.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) return sendJson(res, 401, { error: 'Sign in before viewing connections.' });
    const podId = String(req.query?.podId || '').trim();
    if (!podId) return sendJson(res, 400, { error: 'Choose a pod before viewing connections.' });
    const user = await verifySupabaseUser(accessToken);
    if (!user?.id) return sendJson(res, 401, { error: 'Sign in before viewing connections.' });
    const pod = await loadOwnedPod(accessToken, podId);
    if (!pod) return sendJson(res, 404, { error: 'Pod not found.' });
    const connections = await loadSocialConnections(accessToken, podId);
    return sendJson(res, 200, {
      provider: META_PROVIDER_KEY,
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        providerAccountId: connection.provider_account_id,
        accountLabel: connection.account_label,
        status: connection.status,
        grantedScopes: connection.granted_scopes || [],
        connectedAt: connection.connected_at,
        expiresAt: connection.expires_at,
        updatedAt: connection.updated_at,
      })),
    });
  } catch {
    return sendJson(res, 503, { error: 'Connection status is unavailable.' });
  }
}
