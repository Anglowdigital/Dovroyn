export const META_ORGANIC_PROVIDER = 'instagram';

function idempotencyKey(provider, podId, target = globalThis) {
  const randomId = target.crypto?.randomUUID?.();
  return `connect:${provider}:${podId}:${randomId || Date.now()}`;
}

async function parseJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Meta connection is unavailable.');
  return payload;
}

export async function initiateMetaOrganicConnection({ accessToken, podId, target = globalThis }) {
  if (!accessToken) throw new Error('Sign in before connecting Meta.');
  if (!podId) throw new Error('Choose a pod before connecting Meta.');
  const response = await fetch('/api/integrations/meta/connect', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      podId,
      providerKey: META_ORGANIC_PROVIDER,
      idempotencyKey: idempotencyKey(META_ORGANIC_PROVIDER, podId, target),
    }),
  });
  const payload = await parseJson(response);
  if (!payload.authorizationUrl) throw new Error('Meta connection is unavailable.');
  target.location.assign(payload.authorizationUrl);
  return payload;
}

export async function loadMetaConnectionStatus({ accessToken, podId }) {
  if (!accessToken || !podId) return { available: false, connections: [] };
  const response = await fetch(`/api/integrations/meta/status?podId=${encodeURIComponent(podId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await parseJson(response);
  return {
    available: payload.available === true,
    reason: payload.reason || null,
    connections: Array.isArray(payload.connections) ? payload.connections : [],
  };
}

export function summarizeMetaConnection(status = {}) {
  const connections = Array.isArray(status) ? status : (status.connections || []);
  if (!Array.isArray(status) && status.available !== true) return { status: 'unavailable', label: 'Meta connection unavailable' };
  const active = connections.find((connection) => connection.provider === META_ORGANIC_PROVIDER && connection.status === 'connected');
  if (active) return { status: 'connected', label: active.accountLabel || 'Instagram account' };
  const failed = connections.find((connection) => connection.provider === META_ORGANIC_PROVIDER && ['expired', 'revoked', 'error'].includes(connection.status));
  if (failed) return { status: failed.status, label: 'Reconnect required' };
  return { status: 'setup-ready', label: 'Official Meta sign-in available' };
}
