function getSupabaseServerConfig() {
  // The VITE_ values are the ones the working client bundle is built with, so
  // they are guaranteed to match the live project. Stale dashboard-only server
  // vars (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY) have repeatedly overridden
  // them with wrong values in production, breaking token verification — so the
  // client values win, and the server-only names remain as fallbacks.
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !publishableKey) throw new Error('Supabase server authentication is not configured.');
  return { url: url.replace(/\/$/, ''), publishableKey };
}

async function supabaseFetch(path, accessToken) {
  const { url, publishableKey } = getSupabaseServerConfig();
  return fetch(`${url}${path}`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

async function supabasePost(path, accessToken, body, prefer) {
  const { url, publishableKey } = getSupabaseServerConfig();
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function verifySupabaseUser(accessToken) {
  if (!accessToken) return null;
  const response = await supabaseFetch('/auth/v1/user', accessToken);
  if (!response.ok) return null;
  return response.json();
}

export async function loadOwnedPod(accessToken, podId) {
  const response = await supabaseFetch(`/rest/v1/pods?id=eq.${encodeURIComponent(podId)}&select=id,pod_name,brand_name,pod_type,source_type,source_url,source_locked_at,target_country,accepted_tone,accepted_strategy,status`, accessToken);
  if (!response.ok) return null;
  const rows = await response.json();
  return rows[0] || null;
}

export async function finalizePodAnalysis(accessToken, podId, analysis) {
  const response = await supabasePost('/rest/v1/rpc/finalize_pod_analysis', accessToken, {
    p_pod_id: podId,
    p_analysis: analysis,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.message || 'The analysis could not be saved and locked to this pod.');
    error.status = 422;
    throw error;
  }
  return response.json();
}

export async function loadActiveSubscription(accessToken, userId) {
  const response = await supabaseFetch(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=tier,status,current_period_end,monthly_content_days,max_pods,weekly_posting_days`, accessToken);
  if (!response.ok) return null;
  const rows = await response.json();
  const subscription = rows[0] || null;
  if (!subscription || !['active', 'trialing'].includes(subscription.status)) return null;
  if (!subscription.current_period_end || new Date(subscription.current_period_end) <= new Date()) return null;
  return subscription;
}

export async function loadPodAnalysis(accessToken, podId) {
  const response = await supabaseFetch(`/rest/v1/pod_analysis?pod_id=eq.${encodeURIComponent(podId)}&select=brand_summary,tone,audience,offer_direction,campaign_angles,content_ideas,social_recommendations`, accessToken);
  if (!response.ok) return null;
  const rows = await response.json();
  return rows[0] || null;
}

async function loadRows(accessToken, path) {
  const response = await supabaseFetch(path, accessToken);
  if (!response.ok) return [];
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

export async function loadPodAiContext(accessToken, podId) {
  const encodedPodId = encodeURIComponent(podId);
  const [analysis, sources, preferences, messages] = await Promise.all([
    loadPodAnalysis(accessToken, podId),
    loadRows(accessToken, `/rest/v1/pod_sources?pod_id=eq.${encodedPodId}&select=source_type,source_url,notes,created_at&order=created_at.asc&limit=12`),
    loadRows(accessToken, `/rest/v1/pod_preferences?pod_id=eq.${encodedPodId}&active=eq.true&select=preference_type,preference_value,created_at&order=created_at.desc&limit=20`),
    loadRows(accessToken, `/rest/v1/pod_ai_messages?pod_id=eq.${encodedPodId}&select=role,content,created_at&order=created_at.desc&limit=12`),
  ]);
  // Fetch the latest bounded history, then present older preferences before newer overrides.
  return { analysis, sources, preferences: preferences.reverse(), messages: messages.reverse() };
}

export async function loadLatestPodDirectionPreference(accessToken, podId) {
  const response = await supabaseFetch(`/rest/v1/pod_preferences?pod_id=eq.${encodeURIComponent(podId)}&active=eq.true&preference_type=eq.brand_direction&select=preference_type,preference_value,active,created_at&order=created_at.desc&limit=1`, accessToken);
  if (!response.ok) throw new Error('The approved pod direction could not be verified.');
  const rows = await response.json();
  return Array.isArray(rows) ? (rows[0] || null) : null;
}

export async function savePodAiTurn(accessToken, podId, question, answer) {
  const response = await supabasePost('/rest/v1/pod_ai_messages', accessToken, [
    { pod_id: podId, role: 'user', content: question },
    { pod_id: podId, role: 'assistant', content: answer },
  ], 'return=minimal');
  if (!response.ok) throw new Error('The pod AI answer could not be saved.');
}

export async function reserveContentDay(accessToken, podId, generationDate) {
  const response = await supabasePost('/rest/v1/rpc/reserve_content_day', accessToken, { p_pod_id: podId, p_generation_date: generationDate });
  if (!response.ok) throw new Error('Could not reserve a content day.');
  return response.json();
}

export async function releaseContentDay(accessToken, podId, generationDate) {
  await supabasePost('/rest/v1/rpc/release_content_day', accessToken, { p_pod_id: podId, p_generation_date: generationDate });
}
