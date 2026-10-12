import { getBearerToken, readJsonBody, sendJson } from '../../_lib/http.js';
import { loadOwnedPod, verifySupabaseUser } from '../../_lib/supabaseAuth.js';
import { assertMetaOrganicReady, getMetaOrganicConfig, getMetaSelectionForClient, selectMetaAccounts } from '../../_lib/metaOrganic.js';

async function requireSelectionContext(req, podId) {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    const error = new Error('Sign in before selecting Meta accounts.');
    error.status = 401;
    throw error;
  }
  if (!podId) {
    const error = new Error('Choose a pod before selecting Meta accounts.');
    error.status = 400;
    throw error;
  }
  const user = await verifySupabaseUser(accessToken);
  if (!user?.id) {
    const error = new Error('Sign in before selecting Meta accounts.');
    error.status = 401;
    throw error;
  }
  const pod = await loadOwnedPod(accessToken, podId);
  if (!pod) {
    const error = new Error('Pod not found.');
    error.status = 404;
    throw error;
  }
  return { user, pod };
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  try {
    const body = req.method === 'POST' ? readJsonBody(req) : {};
    const podId = String(body.podId || req.query?.podId || '').trim();
    const selectionId = String(body.selectionId || req.query?.selectionId || '').trim();
    if (!selectionId) return sendJson(res, 400, { error: 'Meta account selection is unavailable.' });
    await assertMetaOrganicReady(getMetaOrganicConfig());
    const { user } = await requireSelectionContext(req, podId);

    if (req.method === 'GET') {
      const selection = await getMetaSelectionForClient({ selectionId, userId: user.id, podId });
      return sendJson(res, 200, { selection });
    }

    const result = await selectMetaAccounts({
      selectionId,
      userId: user.id,
      podId,
      selectedFacebookPageId: body.facebookPageId,
      selectedInstagramAccountId: body.instagramAccountId,
    });
    return sendJson(res, 200, {
      podId: result.podId,
      connections: result.connections,
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    const safeStatus = status >= 400 && status < 500 ? status : 503;
    return sendJson(res, safeStatus, {
      error: safeStatus === 503 ? 'Meta account selection is unavailable.' : error.message,
    });
  }
}
