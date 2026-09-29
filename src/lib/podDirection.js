function requireSavedRow({ data, error }, message) {
  if (error) throw error;
  if (!data) throw new Error(message);
  return data;
}

function storedDirectionValue(preference) {
  const stored = preference?.preference_value;
  if (stored && typeof stored === 'object') return String(stored.value || '').trim();
  if (typeof stored !== 'string') return '';
  try {
    const parsed = JSON.parse(stored);
    return String(parsed?.value || '').trim();
  } catch {
    return stored.trim();
  }
}

export function findLatestPodDirectionPreference(preferences = []) {
  return preferences
    .filter((preference) => preference?.active === true && preference.preference_type === 'brand_direction')
    .reduce((current, preference) => (!current || String(preference.created_at || '') >= String(current.created_at || '')
      ? preference : current), null);
}

export function isPodDirectionApprovalCurrent(pod, preferences = []) {
  if (!['direction_locked', 'active'].includes(String(pod?.status || ''))) return false;
  const latest = findLatestPodDirectionPreference(preferences);
  if (!latest) return true;
  const latestDirection = storedDirectionValue(latest);
  return Boolean(latestDirection && latestDirection === String(pod?.accepted_tone || '').trim());
}

// The caller supplies its authenticated client; existing row-level policies apply.
export async function persistPodDirectionApproval(client, podId, analysis) {
  if (!podId || !analysis) throw new Error('Load this pod and its analysis before approving the direction.');
  return requireSavedRow(await client.from('pods').update({
    status: 'direction_locked',
    accepted_tone: analysis.tone,
    accepted_strategy: analysis.opportunity,
    updated_at: new Date().toISOString(),
  }).eq('id', podId).select().single(), 'The direction approval could not be confirmed.');
}

export async function persistPodDirectionOverride(client, podId, value) {
  const direction = String(value || '').trim();
  if (!podId || !direction) throw new Error('Add a direction for this pod before saving.');

  // Revoke approval before making the new preference active. These are ordered
  // writes, so any partial failure leaves content generation locked for review.
  const pod = requireSavedRow(await client.from('pods').update({
    status: 'awaiting_direction',
    accepted_tone: null,
    accepted_strategy: null,
    updated_at: new Date().toISOString(),
  }).eq('id', podId).select().single(), 'The existing direction approval could not be cleared.');

  const preference = requireSavedRow(await client.from('pod_preferences').insert({
    pod_id: podId,
    preference_type: 'brand_direction',
    preference_value: { value: direction },
    source: 'user_override',
    active: true,
  }).select().single(), 'The new direction could not be confirmed.');

  return { pod, preference };
}

export function restorePodDirection(analysis, preferences = []) {
  if (!analysis) return analysis;
  const latest = findLatestPodDirectionPreference(preferences);
  if (!latest) return analysis;
  const direction = storedDirectionValue(latest);
  if (!direction) return analysis;
  return { ...analysis, tone: direction, userDirection: direction };
}
