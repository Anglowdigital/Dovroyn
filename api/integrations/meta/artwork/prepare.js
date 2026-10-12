import { getBearerToken, readJsonBody, requirePost, sendJson } from '../../../_lib/http.js';
import { prepareArtworkReview } from '../../../_lib/metaOrganicArtworkReview.js';
import { verifySupabaseUser } from '../../../_lib/supabaseAuth.js';

export function createPrepareMetaArtworkHandler(deps = {}) {
  return async function handler(req, res) {
    if (!requirePost(req, res)) return;
    try {
      const accessToken = getBearerToken(req);
      if (!accessToken) return sendJson(res, 401, { error: 'Sign in again before preparing artwork.' });
      const user = await (deps.verifySupabaseUser || verifySupabaseUser)(accessToken);
      if (!user?.id) return sendJson(res, 401, { error: 'Sign in again before preparing artwork.' });
      const body = await readJsonBody(req);
      const result = await (deps.prepareArtworkReview || prepareArtworkReview)({
        accessToken,
        user,
        input: body,
        storage: deps.storage,
        sourceFetcher: deps.sourceFetcher,
        now: deps.now,
        env: deps.env,
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return sendJson(res, status, { error: error?.message || 'Artwork preview could not be prepared.', code: error?.code || 'ARTWORK_PREPARE_FAILED' });
    }
  };
}

export default createPrepareMetaArtworkHandler();
