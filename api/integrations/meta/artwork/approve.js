import { getBearerToken, readJsonBody, requirePost, sendJson } from '../../../_lib/http.js';
import { approveArtworkReviewAndExport } from '../../../_lib/metaOrganicArtworkReview.js';
import { verifySupabaseUser } from '../../../_lib/supabaseAuth.js';

export function createApproveMetaArtworkHandler(deps = {}) {
  return async function handler(req, res) {
    if (!requirePost(req, res)) return;
    try {
      const accessToken = getBearerToken(req);
      if (!accessToken) return sendJson(res, 401, { error: 'Sign in again before approving artwork.' });
      const user = await (deps.verifySupabaseUser || verifySupabaseUser)(accessToken);
      if (!user?.id) return sendJson(res, 401, { error: 'Sign in again before approving artwork.' });
      const body = await readJsonBody(req);
      const result = await (deps.approveArtworkReviewAndExport || approveArtworkReviewAndExport)({
        accessToken,
        user,
        input: body,
        storage: deps.storage,
        sourceFetcher: deps.sourceFetcher,
        store: deps.store,
        rpc: deps.rpc,
        now: deps.now,
        env: deps.env,
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return sendJson(res, status, { error: error?.message || 'Artwork approval could not be completed.', code: error?.code || 'ARTWORK_APPROVE_FAILED' });
    }
  };
}

export default createApproveMetaArtworkHandler();
