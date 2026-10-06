import { requirePost, sendJson } from '../_lib/http.js';

// Public examples are local only. Real AI requires an authenticated Pod via
// pod-chat.js; reject every public payload before parsing or calling providers.
export default async function handler(req, res) {
  if (!requirePost(req, res)) return;
  return sendJson(res, 403, {
    code: 'SIGN_UP_REQUIRED',
    error: 'The public preview uses prepared examples. Sign in to your own pod to use its AI.',
  });
}
