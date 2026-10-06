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

export function selectPodCompetitorSnapshot(preferences = [], podId) {
  return list(preferences).filter((row) => scoped(row, podId) && row.active !== false && row.preference_type === 'competitor_snapshot')
    .map((row, index) => ({ row, index, value: storedValue(row.preference_value) }))
    .filter(({ value }) => record(value))
    .sort((left, right) => (Date.parse(right.row.created_at) || 0) - (Date.parse(left.row.created_at) || 0) || right.index - left.index)[0]?.value || null;
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
    if (value == null || Array.isArray(value) || !['string', 'object'].includes(typeof value) || (record(value) && !Object.keys(value).length)) continue;
    const detail = record(value) ? value.summary || (Array.isArray(value.platforms) ? value.platforms.join(', ') || 'No platforms selected' : null) || value.decision || value : value;
    add(row, row.preference_type, preferenceTitles[row.preference_type], detail, row.created_at, row.source || 'pod_preferences');
  }
  for (const row of list(workspace.campaigns)) {
    if (scoped(row, podId) && (typeof row.name === 'string' || typeof row.status === 'string')) add(row, 'campaign', 'Campaign saved', `${clean(row.name, 200) || 'Campaign'} · ${clean(row.status, 100) || 'Saved'}${row.approved_at ? ' · approval saved' : ''}`, timestamp(row.updated_at, row.created_at, row.approved_at), 'campaigns');
  }
  for (const row of list(workspace.calendarItems || workspace.calendar_items)) {
    if (scoped(row, podId) && timestamp(row.scheduled_date)) add(row, 'calendar', 'Schedule saved', `${clean(row.platform, 100) || 'Schedule'} · ${clean(row.scheduled_date, 30)} · ${clean(row.caption, 300) || 'Saved draft'}`, row.created_at, 'calendar_items');
  }
  for (const row of list(workspace.posts || workspace.social_posts)) {
    if (scoped(row, podId) && typeof row.body === 'string' && row.body.trim()) add(row, 'social_post', row.updated_at && row.updated_at !== row.created_at ? 'Content edit/status saved' : 'Content draft saved', `${clean(row.platform, 100)} · ${clean(row.status, 100) || 'Draft'} · ${clean(row.body, 350)}`, timestamp(row.updated_at, row.created_at), 'social_posts');
  }
  for (const row of list(workspace.budgets)) {
    if (!scoped(row, podId) || row.planned_budget == null || !Number.isFinite(Number(row.planned_budget))) continue;
    add(row, 'budget', 'Planned budget saved', `Planned budget: ${Number(row.planned_budget).toFixed(2)} · Plan only${row.notes ? ` · ${clean(row.notes, 350)}` : ''}`, timestamp(row.updated_at, row.created_at), 'budgets');
  }
  const approvedAt = workspace.pod.direction_approved_at || workspace.pod.directionApprovedAt;
  if (approvedAt) add(workspace.pod, 'direction_approval', 'Pod direction approved', 'A direction approval timestamp was saved for this Pod.', approvedAt, 'pods');
  const count = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 500) : 50;
  return [...events.values()].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id)).slice(0, count);
}
