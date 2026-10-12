import { getBearerToken, readJsonBody, requirePost, sendJson } from '../../../_lib/http.js';
import { prepareCalendarPublishingReview } from '../../../_lib/metaOrganicCalendarPublishingReview.js';
import { verifySupabaseUser } from '../../../_lib/supabaseAuth.js';

export function createPrepareMetaCalendarPublishingHandler(deps = {}) {
  return async function handler(req, res) {
    if (!requirePost(req, res)) return;
    try {
      const accessToken = getBearerToken(req);
      if (!accessToken) return sendJson(res, 401, { error: 'Sign in again before reviewing calendar publishing.' });
      const user = await (deps.verifySupabaseUser || verifySupabaseUser)(accessToken);
      if (!user?.id) return sendJson(res, 401, { error: 'Sign in again before reviewing calendar publishing.' });
      const result = await (deps.prepareCalendarPublishingReview || prepareCalendarPublishingReview)({
        accessToken,
        user,
        input: await readJsonBody(req),
        store: deps.store,
        now: deps.now,
        env: deps.env,
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const unavailable = error?.status === 404 || /not found|could not find|schema cache|rpc/i.test(error?.message || '');
      const status = unavailable ? 503 : (Number.isInteger(error?.status) ? error.status : 500);
      return sendJson(res, status, {
        error: unavailable ? 'Calendar publishing review storage is unavailable.' : (error?.message || 'Calendar publishing review could not be prepared.'),
        code: unavailable ? 'PUBLISH_REVIEW_UNAVAILABLE' : (error?.code || 'PUBLISH_REVIEW_PREPARE_FAILED'),
      });
    }
  };
}

export default createPrepareMetaCalendarPublishingHandler();
