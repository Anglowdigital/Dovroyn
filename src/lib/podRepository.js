import { supabase, supabaseConfigured } from './supabaseClient';

function requireSupabase() {
  if (!supabaseConfigured || !supabase) throw new Error('Supabase is not configured.');
  return supabase;
}

function throwIfError(error) {
  if (error) throw error;
}

export async function loadPodWorkspace(podId) {
  const client = requireSupabase();
  const [pod, sources, analysis] = await Promise.all([
    client.from('pods').select('*').eq('id', podId).single(),
    client.from('pod_sources').select('*').eq('pod_id', podId).order('created_at'),
    client.from('pod_analysis').select('*').eq('pod_id', podId).maybeSingle(),
  ]);

  [pod, sources, analysis].forEach(({ error }) => throwIfError(error));

  const optionalQuery = async (query) => {
    const result = await query;
    if (result.error) return [];
    return result.data || [];
  };
  const [preferences, messages, posts, connections, campaigns, assets] = await Promise.all([
    optionalQuery(client.from('pod_preferences').select('*').eq('pod_id', podId).eq('active', true).order('created_at')),
    optionalQuery(client.from('pod_ai_messages').select('id,role,content,created_at').eq('pod_id', podId).order('created_at', { ascending: true }).limit(30)),
    optionalQuery(client.from('social_posts').select('*').eq('pod_id', podId).order('created_at', { ascending: false })),
    optionalQuery(client.from('social_connections').select('*').eq('pod_id', podId)),
    optionalQuery(client.from('campaigns').select('*').eq('pod_id', podId).order('created_at', { ascending: false })),
    optionalQuery(client.from('pod_assets').select('*').eq('pod_id', podId).order('created_at', { ascending: false })),
  ]);

  return {
    pod: pod.data,
    sources: sources.data || [],
    analysis: analysis.data || null,
    preferences,
    messages,
    posts,
    connections,
    campaigns,
    assets,
  };
}

export async function addPodSource(podId, source) {
  const { data, error } = await requireSupabase().from('pod_sources').insert({ pod_id: podId, ...source }).select().single();
  throwIfError(error);
  return data;
}

export async function savePodPrimarySource(podId, { sourceType, sourceUrl }) {
  const client = requireSupabase();
  const cleanUrl = String(sourceUrl || '').trim() || null;
  const { data: pod, error: podError } = await client.from('pods').update({
    source_type: sourceType,
    source_url: cleanUrl,
    pod_type: sourceType === 'photos' ? 'images' : 'website',
    updated_at: new Date().toISOString(),
  }).eq('id', podId).select().single();
  throwIfError(podError);

  const { data: existing, error: existingError } = await client
    .from('pod_sources')
    .select('id')
    .eq('pod_id', podId)
    .in('source_type', ['website', 'social', 'shopify', 'photos'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  throwIfError(existingError);

  if (cleanUrl) {
    if (existing) {
      const { error } = await client.from('pod_sources').update({ source_type: sourceType, source_url: cleanUrl }).eq('id', existing.id);
      throwIfError(error);
    } else {
      const { error } = await client.from('pod_sources').insert({ pod_id: podId, source_type: sourceType, source_url: cleanUrl });
      throwIfError(error);
    }
  } else if (existing) {
    const { error } = await client.from('pod_sources').update({ source_type: 'photos', source_url: null }).eq('id', existing.id);
    throwIfError(error);
  }

  return pod;
}

export async function savePodAnalysis(podId, analysis) {
  const row = {
    pod_id: podId,
    brand_summary: analysis.summary,
    tone: analysis.tone,
    audience: analysis.audience,
    offer_direction: analysis.offer,
    campaign_angles: analysis.opportunity,
    social_recommendations: JSON.stringify(analysis.platforms || []),
    content_ideas: JSON.stringify(analysis.pillars || []),
    evidence: analysis.evidence || [],
    confidence: analysis.confidence,
    source_captured_at: analysis.source_captured_at,
    personal_data_detected: Boolean(analysis.personal_data_detected),
    personal_data_categories: analysis.personal_data_categories || [],
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await requireSupabase().from('pod_analysis').upsert(row, { onConflict: 'pod_id' }).select().single();
  throwIfError(error);
  return data;
}

export async function savePodPreference(podId, preferenceType, value) {
  const { data, error } = await requireSupabase().from('pod_preferences').insert({
    pod_id: podId,
    preference_type: preferenceType,
    preference_value: { value },
    source: 'user_override',
  }).select().single();
  throwIfError(error);
  return data;
}

export async function saveSocialPosts(podId, posts) {
  const rows = posts.map((post) => ({
    pod_id: podId,
    platform: post.platformKey,
    body: post.content,
    status: 'draft',
    generation_date: new Date().toISOString().slice(0, 10),
  }));
  const { data, error } = await requireSupabase().from('social_posts').insert(rows).select();
  throwIfError(error);
  return data || [];
}

export async function uploadPodAsset({ userId, podId, file, assetRole = 'campaign_asset' }) {
  const client = requireSupabase();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
  const storagePath = `${userId}/${podId}/${crypto.randomUUID()}-${safeName}`;
  const upload = await client.storage.from('pod-assets').upload(storagePath, file, { upsert: false });
  throwIfError(upload.error);

  const { data, error } = await client.from('pod_assets').insert({
    pod_id: podId,
    storage_path: storagePath,
    file_name: file.name,
    media_type: file.type,
    file_size: file.size,
    asset_role: assetRole,
  }).select().single();
  if (error) {
    await client.storage.from('pod-assets').remove([storagePath]).catch(() => undefined);
    throw error;
  }
  return data;
}

export async function getAssetPreview(storagePath) {
  const { data, error } = await requireSupabase().storage.from('pod-assets').createSignedUrl(storagePath, 15 * 60);
  throwIfError(error);
  return data.signedUrl;
}
