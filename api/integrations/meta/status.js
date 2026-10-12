import { getBearerToken, sendJson } from '../../_lib/http.js';
import { loadOwnedPod, verifySupabaseUser } from '../../_lib/supabaseAuth.js';
import { getMetaOrganicConfig, listMetaConnections, loadMetaOrganicReadiness, META_PROVIDER_KEYS, normalizeConnection } from '../../_lib/metaOrganic.js';

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
    const readiness = await loadMetaOrganicReadiness(getMetaOrganicConfig());
    const connections = readiness.ready ? await listMetaConnections(user.id, podId) : [];
    const normalizedConnections = connections
      .filter((connection) => META_PROVIDER_KEYS.includes(connection.provider))
      .map((connection) => normalizeConnection(connection));
    return sendJson(res, 200, {
      provider: 'meta',
      available: readiness.ready,
      reason: readiness.ready ? null : readiness.reason || 'storage_unavailable',
      connections: normalizedConnections,
    });
  } catch {
    return sendJson(res, 503, { error: 'Connection status is unavailable.' });
  }
}
