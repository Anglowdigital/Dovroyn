function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function list(value) { return Array.isArray(value) ? value : []; }

function storedValue(value) {
  if (typeof value === 'string') {
    try { return storedValue(JSON.parse(value)); } catch { return value; }
  }
  return record(value) && Object.hasOwn(value, 'value') ? value.value : value;
}

function clean(value, max = 500) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { return ''; }
  return String(text || '').replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function timestamp(...values) {
  const times = values.filter((value) => typeof value === 'string').map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : '';
}

function scoped(row, podId) { return record(row) && Boolean(podId) && row.pod_id === podId; }
function fallbackId(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

function nonemptyString(value, max = Infinity) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function stringList(value, maxItems = 8, maxLength = 2000) {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => nonemptyString(item, maxLength));
}

function normalizedSnapshotUrl(value) {
  if (!nonemptyString(value, 1000) || !/^https?:\/\/[^/\s]/i.test(value.trim()) || /[\\\u0000-\u0020\u007f]/.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

// Stored rows and cached workspace values are not trusted API responses. Validate
// every field consumed by the UI before restoring a snapshot or its URL inputs.
// Public DNS/address checks still happen server-side when the user refreshes.
export function normalizePodCompetitorSnapshot(stored) {
  const value = storedValue(stored);
  if (!record(value) || !nonemptyString(value.summary, 2000)
    || !Array.isArray(value.competitors) || value.competitors.length < 1 || value.competitors.length > 3
    || !stringList(value.opportunities) || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
    || !timestamp(value.checked_at) || !Array.isArray(value.evidence) || value.evidence.length < value.competitors.length || value.evidence.length > 12) return null;
  const competitors = [];
  const urls = new Set();
  for (const item of value.competitors) {
    if (!record(item) || !nonemptyString(item.positioning, 2000) || !stringList(item.public_strengths) || !stringList(item.public_gaps)) return null;
    const url = normalizedSnapshotUrl(item.url);
    if (!url || urls.has(url)) return null;
    urls.add(url);
    competitors.push({ ...item, url });
  }
  const covered = new Set();
  for (const item of value.evidence) {
    if (!record(item) || !nonemptyString(item.source_reference, 100) || !nonemptyString(item.finding, 2000)) return null;
    const label = item.source_reference.match(/^competitor_([1-3])_website_(?:home|page_2)$/);
    if (!label || Number(label[1]) > competitors.length) return null;
    covered.add(label[1]);
  }
  if (covered.size !== competitors.length) return null;
  return { ...value, competitors, checked_at: timestamp(value.checked_at) };
}

function preferenceDetail(type, value) {
  switch (type) {
    case 'brand_direction':
    case 'direction_override':
      return nonemptyString(value) ? value : null;
    case 'platform_selection':
      return record(value) && stringList(value.platforms, 50, 100) ? value.platforms.join(', ') || 'No platforms selected' : null;
    case 'website_intelligence':
      return record(value) && nonemptyString(value.summary) ? value.summary : null;
    case 'competitor_snapshot':
      return normalizePodCompetitorSnapshot(value)?.summary || null;
    case 'budget_recommendation_decision':
    case 'budget_decision': {
      const decision = record(value) ? value.decision : value;
      return typeof decision === 'string' && ['approved', 'rejected', 'pending'].includes(decision) ? decision : null;
    }
    default:
      return null;
  }
}

function optionalString(value) { return value == null || typeof value === 'string'; }

export function selectPodCompetitorSnapshot(preferences = [], podId) {
  return list(preferences).filter((row) => scoped(row, podId) && row.active !== false && row.preference_type === 'competitor_snapshot')
    .map((row, index) => ({ row, index, value: normalizePodCompetitorSnapshot(row.preference_value) }))
    .filter(({ row, value }) => value && timestamp(row.created_at))
    .sort((left, right) => Date.parse(timestamp(right.row.created_at)) - Date.parse(timestamp(left.row.created_at)) || right.index - left.index)[0]?.value || null;
}

// A bounded view of saved current rows, not an immutable or complete audit log.
export function normalizePodLearning(workspace, { limit = 50 } = {}) {
  if (!record(workspace) || !workspace.pod?.id) return [];
  const podId = workspace.pod.id;
  const events = new Map();
  const add = (row, type, title, detail, at, source) => {
    const occurredAt = timestamp(at);
    const safeDetail = clean(detail);
    if (!occurredAt || !safeDetail) return;
    const id = `${type}:${clean(podId, 100)}:${clean(row.id, 150) || fallbackId(`${occurredAt}|${safeDetail}`)}`;
    events.set(id, { id, type, title: clean(title, 150), detail: safeDetail, occurredAt, source: clean(source || 'saved_record', 100) });
  };
  const preferenceTitles = {
    brand_direction: 'User direction saved', direction_override: 'Direction override saved', platform_selection: 'Platform selection saved',
    website_intelligence: 'Website intelligence saved', budget_recommendation_decision: 'Budget decision saved', budget_decision: 'Budget decision saved', competitor_snapshot: 'Public competitor snapshot saved',
  };
  for (const row of list(workspace.preferences)) {
    if (!scoped(row, podId) || !Object.hasOwn(preferenceTitles, row.preference_type)) continue;
    const value = storedValue(row.preference_value);
    const detail = preferenceDetail(row.preference_type, value);
    if (detail === null) continue;
    add(row, row.preference_type, preferenceTitles[row.preference_type], detail, row.created_at, row.source || 'pod_preferences');
  }
  for (const row of list(workspace.campaigns)) {
    if (scoped(row, podId) && optionalString(row.name) && optionalString(row.status) && (nonemptyString(row.name) || nonemptyString(row.status))) add(row, 'campaign', 'Campaign saved', `${clean(row.name, 200) || 'Campaign'} · ${clean(row.status, 100) || 'Saved'}${timestamp(row.approved_at) ? ' · approval saved' : ''}`, timestamp(row.updated_at, row.created_at, row.approved_at), 'campaigns');
  }
  for (const row of list(workspace.calendarItems || workspace.calendar_items)) {
    if (scoped(row, podId) && timestamp(row.scheduled_date) && optionalString(row.platform) && optionalString(row.caption)) add(row, 'calendar', 'Schedule saved', `${clean(row.platform, 100) || 'Schedule'} · ${clean(row.scheduled_date, 30)} · ${clean(row.caption, 300) || 'Saved draft'}`, row.created_at, 'calendar_items');
  }
  for (const row of list(workspace.posts || workspace.social_posts)) {
    if (scoped(row, podId) && nonemptyString(row.body) && optionalString(row.platform) && optionalString(row.status)) add(row, 'social_post', timestamp(row.updated_at) && row.updated_at !== row.created_at ? 'Content edit/status saved' : 'Content draft saved', `${clean(row.platform, 100)} · ${clean(row.status, 100) || 'Draft'} · ${clean(row.body, 350)}`, timestamp(row.updated_at, row.created_at), 'social_posts');
  }
  for (const row of list(workspace.budgets)) {
    if (!scoped(row, podId) || !['string', 'number'].includes(typeof row.planned_budget) || (typeof row.planned_budget === 'string' && !row.planned_budget.trim())
      || !Number.isFinite(Number(row.planned_budget)) || Number(row.planned_budget) < 0 || !optionalString(row.notes)) continue;
    add(row, 'budget', 'Planned budget saved', `Planned budget: ${Number(row.planned_budget).toFixed(2)} · Plan only${row.notes ? ` · ${clean(row.notes, 350)}` : ''}`, timestamp(row.updated_at, row.created_at), 'budgets');
  }
  const approvedAt = workspace.pod.direction_approved_at || workspace.pod.directionApprovedAt;
  if (approvedAt) add(workspace.pod, 'direction_approval', 'Pod direction approved', 'A direction approval timestamp was saved for this Pod.', approvedAt, 'pods');
  const count = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 500) : 50;
  return [...events.values()].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id)).slice(0, count);
}
