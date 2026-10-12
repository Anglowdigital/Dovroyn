export const META_ORGANIC_PROVIDER = 'instagram';
export const META_FACEBOOK_PROVIDER = 'facebook';
export const META_PROVIDERS = [META_ORGANIC_PROVIDER, META_FACEBOOK_PROVIDER];

function idempotencyKey(provider, podId, target = globalThis) {
  const randomId = target.crypto?.randomUUID?.();
  return `connect:${provider}:${podId}:${randomId || Date.now()}`;
}

async function parseJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Meta connection is unavailable.');
  return payload;
}

export function isMetaOrganicProvider(provider) {
  return META_PROVIDERS.includes(String(provider || '').toLowerCase());
}

export async function initiateMetaOrganicConnection({ accessToken, podId, providerKey = META_ORGANIC_PROVIDER, target = globalThis }) {
  if (!accessToken) throw new Error('Sign in before connecting Meta.');
  if (!podId) throw new Error('Choose a pod before connecting Meta.');
  const provider = isMetaOrganicProvider(providerKey) ? providerKey : META_ORGANIC_PROVIDER;
  const response = await fetch('/api/integrations/meta/connect', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      podId,
      providerKey: provider,
      idempotencyKey: idempotencyKey(provider, podId, target),
    }),
  });
  const payload = await parseJson(response);
  if (!payload.authorizationUrl) throw new Error('Meta connection is unavailable.');
  target.location.assign(payload.authorizationUrl);
  return payload;
}

export async function loadMetaAccountSelection({ accessToken, podId, selectionId }) {
  if (!accessToken || !podId || !selectionId) throw new Error('Meta account selection is unavailable.');
  const params = new URLSearchParams({ podId, selectionId });
  const response = await fetch(`/api/integrations/meta/selection?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await parseJson(response);
  return payload.selection;
}

export async function selectMetaAccounts({ accessToken, podId, selectionId, facebookPageId, instagramAccountId }) {
  if (!accessToken || !podId || !selectionId) throw new Error('Meta account selection is unavailable.');
  const response = await fetch('/api/integrations/meta/selection', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      podId,
      selectionId,
      facebookPageId,
      instagramAccountId,
    }),
  });
  return parseJson(response);
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

export async function prepareMetaArtworkReview({ accessToken, podId, postId, headline, callToAction, image, imageRole, brandName }) {
  if (!accessToken) throw new Error('Sign in before preparing artwork.');
  const response = await fetch('/api/integrations/meta/artwork/prepare', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ podId, postId, headline, callToAction, image, imageRole, brandName }),
  });
  return parseJson(response);
}

export async function approveMetaArtworkReview({ accessToken, podId, postId, preparationToken, accountSnapshotFingerprint }) {
  if (!accessToken) throw new Error('Sign in before approving artwork.');
  const response = await fetch('/api/integrations/meta/artwork/approve', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ podId, postId, preparationToken, accountSnapshotFingerprint }),
  });
  return parseJson(response);
}

export async function prepareMetaCalendarPublishingReview({ accessToken, podId, scheduledDate }) {
  if (!accessToken) throw new Error('Sign in before reviewing calendar publishing.');
  const response = await fetch('/api/integrations/meta/calendar/prepare', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ podId, scheduledDate }),
  });
  return parseJson(response);
}

export async function confirmMetaCalendarPublishingReview({ accessToken, podId, scheduledDate, preparationToken, loadedEntryIds }) {
  if (!accessToken) throw new Error('Sign in before confirming calendar publishing.');
  const response = await fetch('/api/integrations/meta/calendar/confirm', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ podId, scheduledDate, preparationToken, loadedEntryIds }),
  });
  return parseJson(response);
}

export function summarizeMetaConnection(status = {}, provider = META_ORGANIC_PROVIDER) {
  const connections = Array.isArray(status) ? status : (status.connections || []);
  if (!Array.isArray(status) && status.available !== true) return { status: 'unavailable', label: 'Meta connection unavailable' };
  const activeConnections = connections.filter((connection) => connection.provider === provider && connection.status === 'connected');
  if (activeConnections.length) {
    const fallback = provider === META_FACEBOOK_PROVIDER ? 'Facebook Page' : 'Instagram account';
    const labels = [...new Set(activeConnections.map((connection) => connection.accountLabel || fallback))];
    return { status: 'connected', label: labels.join(' · '), labels };
  }
  const failed = connections.find((connection) => connection.provider === provider && ['expired', 'revoked', 'error', 'reconnect_required'].includes(connection.status));
  if (failed) return { status: failed.status, label: 'Reconnect required' };
  return { status: 'setup-ready', label: 'Official Meta sign-in available' };
}
