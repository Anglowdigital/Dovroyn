const CAMPAIGN_STATUSES = ['draft', 'review', 'approved', 'active', 'completed', 'archived'];
const CALENDAR_STATUSES = ['draft', 'approved', 'scheduled', 'posted', 'failed'];

function requirePodId(podId) {
  if (typeof podId !== 'string' || !podId.trim()) throw new Error('A Pod ID is required.');
  return podId.trim();
}

function platformSelection(keys) {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key.trim())) {
    throw new Error('Platform keys must be an array of non-empty strings.');
  }
  return [...new Set(keys.map((key) => key.trim()))];
}

async function confirmed(query, collection, multiple = false) {
  const { data, error } = await query;
  if (error) throw new Error(`${collection}: ${error.message || 'operation failed'}`, { cause: error });
  if (!data || (multiple && !data.length)) throw new Error(`${collection} write could not be confirmed.`);
  return data;
}

export async function persistPlatformSelection(client, podId, platformKeys) {
  const id = requirePodId(podId);
  const platforms = platformSelection(platformKeys);
  const row = await confirmed(client.from('pod_preferences').insert({
    pod_id: id, preference_type: 'platform_selection', preference_value: { platforms }, source: 'user_override', active: true,
  }).select().single(), 'pod_preferences');
  // Insert first: a rejected save must leave the previous selection active.
  const { error } = await client.from('pod_preferences').update({ active: false })
    .eq('pod_id', id).eq('preference_type', 'platform_selection').eq('active', true)
    .neq('id', row.id).lte('created_at', row.created_at);
  if (error) throw new Error(`pod_preferences: ${error.message || 'previous selection could not be deactivated'}`, { cause: error });
  return row;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('A valid calendar month is required.');
  const start = `${month}-01`;
  const next = new Date(`${start}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return [start, next.toISOString().slice(0, 10)];
}

export async function persistCalendarItems(client, podId, items) {
  const id = requirePodId(podId);
  if (!Array.isArray(items) || !items.length) throw new Error('Calendar items are required.');
  const month = items[0]?.scheduled_date?.slice(0, 7);
  const rows = items.map((item) => {
    if (!validDate(item.scheduled_date) || item.scheduled_date.slice(0, 7) !== month) throw new Error('Calendar items must use valid dates in one month.');
    if (typeof item.platform !== 'string' || !item.platform.trim() || typeof item.content_type !== 'string' || !item.content_type.trim()) throw new Error('Calendar platform and content type are required.');
    const status = item.status ?? 'draft';
    if (!CALENDAR_STATUSES.includes(status)) throw new Error('Invalid calendar status.');
    return {
      pod_id: id, platform: item.platform.trim(), scheduled_date: item.scheduled_date, content_type: item.content_type.trim(),
      caption: item.caption ?? null, creative_note: item.creative_note ?? null, status, approved: item.approved === true,
    };
  });
  const [start, end] = monthBounds(month);
  const { data, error } = await client.from('calendar_items').select('*').eq('pod_id', id)
    .gte('scheduled_date', start).lt('scheduled_date', end).order('scheduled_date');
  if (error) throw new Error(`calendar_items: ${error.message}`, { cause: error });
  if (data?.length) return data;
  return confirmed(client.from('calendar_items').insert(rows).select(), 'calendar_items', true);
}

export function buildCalendarItems({ month, posts, platformKeys, weeklyPostingDays, monthlyContentDays }) {
  const [start, end] = monthBounds(month);
  const weekdays = [0, 2, 4, 6, 1, 3, 5].slice(0, Math.min(7, Math.max(0, Math.floor(weeklyPostingDays || 0))));
  const limit = Math.max(0, Math.floor(monthlyContentDays || 0));
  const drafts = platformSelection(platformKeys).map((key) => posts.find((post) => post.platformKey === key)).filter(Boolean);
  const rows = [];
  let days = 0;
  for (let date = new Date(`${start}T12:00:00Z`); date.toISOString().slice(0, 10) < end && days < limit; date.setUTCDate(date.getUTCDate() + 1)) {
    if (!weekdays.includes((date.getUTCDay() + 6) % 7) || !drafts.length) continue;
    days += 1;
    for (const post of drafts) rows.push({
      platform: post.platformKey, scheduled_date: date.toISOString().slice(0, 10), content_type: post.contentStyle || 'Post',
      caption: post.content, status: 'draft', approved: false,
    });
  }
  return rows;
}

export async function persistCampaignDecision(client, podId, { campaignId, name, status, objective, brief, startsOn, endsOn }) {
  const id = requirePodId(podId);
  if (typeof name !== 'string' || !name.trim()) throw new Error('Campaign name is required.');
  if (!CAMPAIGN_STATUSES.includes(status)) throw new Error('Invalid campaign status.');
  if ((startsOn != null && !validDate(startsOn)) || (endsOn != null && !validDate(endsOn))) throw new Error('Invalid campaign date.');
  const row = { name: name.trim(), status, updated_at: new Date().toISOString() };
  if (objective !== undefined) row.objective = objective;
  if (brief !== undefined) row.brief = brief;
  if (startsOn !== undefined) row.starts_on = startsOn;
  if (endsOn !== undefined) row.ends_on = endsOn;
  const query = campaignId
    ? client.from('campaigns').update(row).eq('pod_id', id).eq('id', campaignId)
    : client.from('campaigns').insert({ pod_id: id, ...row });
  return confirmed(query.select().single(), 'campaigns');
}

export async function persistBudgetPlan(client, podId, { plannedBudget, notes }) {
  const id = requirePodId(podId);
  if (typeof plannedBudget !== 'number' || !Number.isFinite(plannedBudget) || plannedBudget < 0) throw new Error('Planned budget must be a finite, non-negative amount.');
  return confirmed(client.from('budgets').upsert({
    pod_id: id, planned_budget: plannedBudget, notes: notes ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: 'pod_id' }).select().single(), 'budgets');
}

export async function persistPreferenceDecision(client, podId, preferenceType, value) {
  const id = requirePodId(podId);
  if (typeof preferenceType !== 'string' || !preferenceType.trim() || value == null) throw new Error('Preference type and value are required.');
  return confirmed(client.from('pod_preferences').insert({
    pod_id: id, preference_type: preferenceType.trim(), preference_value: value, source: 'user_override', active: true,
  }).select().single(), 'pod_preferences');
}

export async function persistHolidayPreference(client, podId, payload) {
  const id = requirePodId(podId);
  const country = String(payload.country_code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('A two-letter target country is required.');
  const enabled = payload.include_religious_observances === true;
  const selected = payload.selected_observances ?? [];
  if (!Array.isArray(selected) || selected.some((value) => typeof value !== 'string' || !value.trim())) throw new Error('Selected observances must be explicit names.');
  return confirmed(client.from('holiday_preferences').upsert({
    pod_id: id, country_code: country, region_code: payload.region_code ?? null,
    include_public_holidays: payload.include_public_holidays !== false,
    include_religious_observances: enabled, selected_observances: enabled ? [...new Set(selected.map((value) => value.trim()))] : [],
    updated_at: new Date().toISOString(),
  }, { onConflict: 'pod_id' }).select().single(), 'holiday_preferences');
}

export async function loadOperationalCollections(client, podId) {
  const id = requirePodId(podId);
  const tables = { calendarItems: 'calendar_items', campaigns: 'campaigns', budgets: 'budgets', holidayPreferences: 'holiday_preferences', adAnalysis: 'ad_analysis' };
  return Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([key, table]) => {
    let query = client.from(table).select('*').eq('pod_id', id);
    if (table === 'ad_analysis') query = query.order('updated_at', { ascending: false })
      .order('created_at', { ascending: false }).order('id', { ascending: false });
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message || 'collection could not be loaded'}`, { cause: error });
    return [key, data || []];
  })));
}

export function restoreOperationalState(workspace) {
  const podId = workspace.pod?.id;
  const own = (row) => row && typeof row === 'object' && !Array.isArray(row) && (!podId || !row.pod_id || row.pod_id === podId);
  const newestFirst = (rows) => (Array.isArray(rows) ? [...rows] : []).filter(own).sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));
  const newest = (rows) => newestFirst(rows)[0] || null;
  const preferences = (type) => newestFirst(workspace.preferences).filter((row) => row.active !== false && row.preference_type === type);
  const preference = (type) => preferences(type)[0];
  const selections = preferences('platform_selection');
  const platformKeys = selections.map((row) => {
    let value = row.preference_value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return null; }
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'value')) value = value.value;
    const keys = value?.platforms;
    // Writer validation is strict; restoration instead skips bad saved rows.
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key.trim())) return null;
    return platformSelection(keys);
  }).find((keys) => keys !== null);
  const decision = preference('budget_recommendation_decision')?.preference_value?.decision;
  const budget = newest(workspace.budgets);
  const latestAdAnalysis = [...(workspace.adAnalysis || [])].filter(own).sort((a, b) =>
    String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''))
    || String(b.created_at || '').localeCompare(String(a.created_at || ''))
    || String(b.id || '').localeCompare(String(a.id || '')))[0];
  return {
    platformKeys: platformKeys ?? (selections.length ? [] : null),
    calendarItems: [...(workspace.calendarItems || [])].filter(own).sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date)),
    campaign: newest(workspace.campaigns), budget: budget ? { ...budget, planned_budget: Number(budget.planned_budget) || 0 } : null,
    holidayPreference: newest(workspace.holidayPreferences), budgetDecision: ['approved', 'rejected'].includes(decision) ? decision : 'pending',
    budgetRecommendation: latestAdAnalysis?.recommendation || '',
  };
}
