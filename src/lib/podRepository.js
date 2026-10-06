import { supabase, supabaseConfigured } from './supabaseClient';
import { persistPodDirectionApproval, persistPodDirectionOverride } from './podDirection.js';
import { normalizePodLearning, selectPodCompetitorSnapshot } from './podLearning.js';
import {
  loadOperationalCollections, persistPlatformSelection, persistCalendarItems,
  persistCampaignDecision, persistBudgetPlan, persistPreferenceDecision, persistHolidayPreference,
} from './podState.js';

function requireSupabase() {
  if (!supabaseConfigured || !supabase) throw new Error('Supabase is not configured.');
  return supabase;
}

function throwIfError(error) {
  if (error) throw error;
}

function structuredPreferenceValue(value) {
  return value !== null && typeof value === 'object' ? value : { value };
}

export function selectWebsiteIntelligenceSnapshot(preferences = [], podId) {
  return (Array.isArray(preferences) ? preferences : [])
    .map((preference, index) => ({ preference, index }))
    .filter(({ preference }) => preference?.preference_type === 'website_intelligence'
      && preference.active !== false && (!podId || preference.pod_id === podId))
    .sort((left, right) => {
      const leftTime = Date.parse(left.preference.created_at || '') || 0;
      const rightTime = Date.parse(right.preference.created_at || '') || 0;
      return rightTime - leftTime || right.index - left.index;
    })
    .map(({ preference }) => {
      let value = preference.preference_value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return null; }
      }
      if (!isRecord(value)) return null;
      if (Object.hasOwn(value, 'value')) value = value.value;
      if (!isRecord(value)) return null;
      const fields = WEBSITE_INTELLIGENCE_FIELDS.filter((field) => Object.hasOwn(value, field));
      // A broken newer snapshot must not hide a valid older observation.
      if (!fields.length || fields.some((field) => !validIntelligenceField(field, value[field]))) return null;
      return Object.fromEntries(fields.map((field) => [field, value[field]]));
    })
    .find(Boolean) || null;
}

const WEBSITE_INTELLIGENCE_FIELDS = [
  'brand_colours', 'geography', 'products_services', 'visual_style', 'site_structure', 'best_landing_pages',
  'weak_pages', 'seo_opportunities', 'content_opportunities', 'audience_fit',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validIntelligenceField(field, value) {
  if (['visual_style', 'audience_fit'].includes(field)) return typeof value === 'string';
  if (field === 'brand_colours') return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.name === 'string' && typeof item.hex === 'string' && /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(item.hex));
  if (['best_landing_pages', 'weak_pages'].includes(field)) {
    const detail = field === 'best_landing_pages' ? 'reason' : 'issue';
    return Array.isArray(value) && value.every((item) => isRecord(item)
      && typeof item.source_reference === 'string' && typeof item[detail] === 'string');
  }
  return stringList(value);
}

function parseStoredList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function restorePodAnalysisSnapshot(canonicalAnalysis, websiteIntelligence) {
  if (!isRecord(canonicalAnalysis)) return null;
  const rich = {};
  if (isRecord(websiteIntelligence)) {
    WEBSITE_INTELLIGENCE_FIELDS.forEach((field) => {
      if (validIntelligenceField(field, websiteIntelligence[field])) rich[field] = websiteIntelligence[field];
    });
  }
  const text = (value) => typeof value === 'string' ? value : '';
  const confidence = ['number', 'string'].includes(typeof canonicalAnalysis.confidence) && canonicalAnalysis.confidence !== ''
    ? Number(canonicalAnalysis.confidence) : null;
  const evidence = (Array.isArray(canonicalAnalysis.evidence) ? canonicalAnalysis.evidence : [])
    .filter((item) => isRecord(item) && typeof item.source_reference === 'string' && typeof item.finding === 'string')
    .map((item) => ({ source_reference: item.source_reference, finding: item.finding,
      ...(typeof item.source_type === 'string' ? { source_type: item.source_type } : {}),
      ...(typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1 ? { confidence: item.confidence } : {}),
    }));
  return {
    ...rich,
    summary: text(canonicalAnalysis.brand_summary),
    tone: text(canonicalAnalysis.tone),
    audience: text(canonicalAnalysis.audience),
    offer: text(canonicalAnalysis.offer_direction),
    opportunity: text(canonicalAnalysis.campaign_angles),
    evidence,
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
    source_captured_at: typeof canonicalAnalysis.source_captured_at === 'string' && Number.isFinite(Date.parse(canonicalAnalysis.source_captured_at)) ? canonicalAnalysis.source_captured_at : undefined,
    personal_data_detected: canonicalAnalysis.personal_data_detected === true,
    personal_data_categories: parseStoredList(canonicalAnalysis.personal_data_categories),
    platforms: parseStoredList(canonicalAnalysis.social_recommendations),
    pillars: parseStoredList(canonicalAnalysis.content_ideas),
  };
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
  const [preferences, messages, posts, connections, assets, operational] = await Promise.all([
    client.from('pod_preferences').select('*').eq('pod_id', podId).eq('active', true).order('created_at'),
    optionalQuery(client.from('pod_ai_messages').select('id,role,content,created_at').eq('pod_id', podId).order('created_at', { ascending: true }).limit(30)),
    client.from('social_posts').select('*').eq('pod_id', podId).order('created_at', { ascending: false }),
    optionalQuery(client.from('social_connections').select('*').eq('pod_id', podId)),
    optionalQuery(client.from('pod_assets').select('*').eq('pod_id', podId).order('created_at', { ascending: false })),
    loadOperationalCollections(client, podId),
  ]);
  // Direction review must not silently fall back to old analysis if saved
  // overrides cannot be read.
  if (preferences.error) throw new Error(`pod_preferences: ${preferences.error.message || 'collection could not be loaded'}`, { cause: preferences.error });
  if (posts.error) throw new Error(`social_posts: ${posts.error.message || 'saved content history could not be loaded'}`, { cause: posts.error });
  const websiteIntelligence = selectWebsiteIntelligenceSnapshot(preferences.data, podId);

  const workspace = {
    pod: pod.data,
    sources: sources.data || [],
    analysis: analysis.data || null,
    preferences: preferences.data || [],
    websiteIntelligence,
    restoredAnalysis: restorePodAnalysisSnapshot(analysis.data, websiteIntelligence),
    messages,
    posts: posts.data || [],
    connections,
    assets,
    ...operational,
  };
  return { ...workspace, competitorSnapshot: selectPodCompetitorSnapshot(workspace.preferences, podId), learningEvents: normalizePodLearning(workspace) };
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

export async function persistPodPreference(client, podId, preferenceType, value, source = 'user_override') {
  const { data, error } = await client.from('pod_preferences').insert({
    pod_id: podId,
    preference_type: preferenceType,
    preference_value: structuredPreferenceValue(value),
    source,
  }).select().single();
  throwIfError(error);
  return data;
}

export async function savePodPreference(podId, preferenceType, value, source = 'user_override') {
  return persistPodPreference(requireSupabase(), podId, preferenceType, value, source);
}

export async function saveWebsiteIntelligenceSnapshot(podId, analysis, savePreference = savePodPreference) {
  try {
    await savePreference(podId, 'website_intelligence', analysis, 'observed_result');
    return true;
  } catch {
    return false;
  }
}

export const savePlatformSelection = (podId, keys) => persistPlatformSelection(requireSupabase(), podId, keys);
export const saveCalendarItems = (podId, items) => persistCalendarItems(requireSupabase(), podId, items);
export const saveCampaignDecision = (podId, decision) => persistCampaignDecision(requireSupabase(), podId, decision);
export const saveBudgetPlan = (podId, plan) => persistBudgetPlan(requireSupabase(), podId, plan);
export const savePreferenceDecision = (podId, type, value) => persistPreferenceDecision(requireSupabase(), podId, type, value);
export const saveHolidayPreference = (podId, preference) => persistHolidayPreference(requireSupabase(), podId, preference);

export async function approvePodDirection(podId, analysis) {
  return persistPodDirectionApproval(requireSupabase(), podId, analysis);
}

export async function savePodDirectionOverride(podId, value) {
  return persistPodDirectionOverride(requireSupabase(), podId, value);
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

export async function updateSocialPost(postId, body) {
  const { data, error } = await requireSupabase().from('social_posts')
    .update({ body, updated_at: new Date().toISOString() })
    .eq('id', postId)
    .select()
    .single();
  throwIfError(error);
  return data;
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
  // 2 hours — previews live in workspace state long past the old 15-minute window.
  const { data, error } = await requireSupabase().storage.from('pod-assets').createSignedUrl(storagePath, 7200);
  throwIfError(error);
  return data.signedUrl;
}
