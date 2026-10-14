import { normalizeAccountTarget } from './podState.js';
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

export async function initiateMetaOrganicConnection({ accessToken, podId, providerKey = META_ORGANIC_PROVIDER, connectionIntent = 'discovery', target = globalThis }) {
  if (!accessToken) throw new Error('Sign in before connecting Meta.');
  if (!podId) throw new Error('Choose a pod before connecting Meta.');
  if (!['discovery', 'publish'].includes(connectionIntent)) throw new Error('Choose a valid Meta connection purpose.');
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
      connectionIntent,
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

export function metaAccountTargetKey(account) {
  const provider = account?.provider || '';
  return provider + ':' + (account?.accountConnectionId
    ? 'connection:' + account.accountConnectionId : 'legacy:' + (account?.providerAccountId || ''));
}

export function resolveMetaAccountTargets(targets, accounts) {
  return (Array.isArray(targets) ? targets : []).flatMap(target => {
    const matches = (Array.isArray(accounts) ? accounts : []).filter(account =>
      account.provider === target?.provider && account.providerAccountId === target?.providerAccountId
      && (!target.accountConnectionId || account.accountConnectionId === target.accountConnectionId));
    if (matches.length !== 1) return [];
    // A legacy discovery snapshot is never implicitly promoted to publishing access.
    if (!target.accountConnectionId && matches[0].connectionIntent === 'publish') return [];
    return [normalizeAccountTarget(matches[0])];
  });
}

export function toggleMetaAccountTarget(existing, accounts, connectionId, checked) {
  const matches = accounts.filter(account => account.accountConnectionId
    ? account.accountConnectionId === connectionId : account.providerAccountId === connectionId);
  if (matches.length !== 1) throw new Error('Choose a current account connection before saving.');
  const target = matches[0];
  if (checked) {
    // Selecting a different connection for the same account is explicit; never select both.
    return [...existing.filter(account => account.provider !== target.provider
      || account.providerAccountId !== target.providerAccountId), normalizeAccountTarget(target)];
  }
  return existing.filter(account => !resolveMetaAccountTargets([account], accounts)
    .some(current => metaAccountTargetKey(current) === metaAccountTargetKey(target)));
}

export function metaAccountChoiceLabel(account, distinguish = false) {
  if (!distinguish) return account.accountLabel;
  return account.accountLabel + (account.connectionIntent === 'publish'
    ? ' · Publishing access' : ' · Account discovery');
}
