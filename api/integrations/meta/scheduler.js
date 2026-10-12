import { sendJson } from '../../_lib/http.js';
import { runMetaOrganicScheduler } from '../../_lib/metaOrganicScheduler.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const result = await runMetaOrganicScheduler({ req });
    const status = result.status === 'unauthorized' ? 401 : (result.status === 'unavailable' ? 503 : 200);
    return sendJson(res, status, result);
  } catch {
    return sendJson(res, 503, { status: 'unavailable', reason: 'scheduler_unavailable' });
  }
}
