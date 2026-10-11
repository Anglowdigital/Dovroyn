import { buildIntegrationRedirect, completeMetaCallback } from '../_lib/metaOrganic.js';

function redirect(res, location) {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: location });
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    redirect(res, buildIntegrationRedirect({ status: 'error', reason: 'connection_unavailable' }));
    return;
  }
  const query = req.query || {};
  try {
    const result = await completeMetaCallback({
      code: query.code,
      state: query.state,
      errorCode: query.error || query.error_code,
    });
    redirect(res, buildIntegrationRedirect({
      podId: result.podId,
      status: 'connected',
      connectionId: result.connectionId,
    }));
  } catch (error) {
    redirect(res, buildIntegrationRedirect({
      status: 'error',
      reason: error.code || 'connection_unavailable',
    }));
  }
}
