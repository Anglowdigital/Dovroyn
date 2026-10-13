import { creativeReviewPayload } from './creativeReview.js';
import { persistPreferenceDecision } from './podState.js';

const ordered = (value) => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;

const pendingDrafts = new WeakMap();

// Reuse the authenticated, owner-scoped preference store. A new draft revision
// supersedes approval without rewriting approved artwork or calendar snapshots.
export async function persistCreativeDraft(client, podId, post, headline, cta, selected, brandName) {
  const payload = creativeReviewPayload(post?.id, headline, cta, selected, false, post?.content || '', { brandName });
  // A remounted editor must not let an older slow request overwrite its newer save.
  const pending = pendingDrafts.get(client) || new Map();
  pendingDrafts.set(client, pending);
  const key = JSON.stringify([podId, post.id]);
  const operation = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => writeDraft(client, podId, payload));
  pending.set(key, operation);
  try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}

async function writeDraft(client, podId, payload) {
  const row = await persistPreferenceDecision(client, podId, 'creative_review', payload);
  let value;
  try { value = typeof row?.preference_value === 'string' ? JSON.parse(row.preference_value) : row?.preference_value; } catch { value = null; }
  if (!row?.id || row.pod_id !== podId || row.preference_type !== 'creative_review' || row.active !== true
    || !Number.isFinite(Date.parse(row.created_at))
    || JSON.stringify(ordered(value)) !== JSON.stringify(ordered(payload))) {
    throw new Error('Creative draft save could not be confirmed. Reload before retrying.');
  }
  return row;
}
