import { creativeImageCandidates, imageReferenceKey, latestCreativeReview, creativeReviewIsCurrent } from './creativeReview.js';

const KIND = 'dovroyn_calendar_creative';
const list = (value) => Array.isArray(value) ? value : [];
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const platform = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';

// This is an artwork approval snapshot, never a publishing approval.
export function decodeCalendarCreative(note) {
  if (typeof note !== 'string') return null;
  try {
    const data = JSON.parse(note);
    if (data?.kind !== KIND || data.version !== 1 || typeof data.pod_id !== 'string' || !data.pod_id || typeof data.post_id !== 'string' || !data.post_id
      || typeof data.platform !== 'string' || !data.platform || typeof data.headline !== 'string' || !data.headline.trim()
      || typeof data.call_to_action !== 'string' || typeof data.content_snapshot !== 'string' || !iso(data.approved_at)) return null;
    let image = null;
    if (data.image !== null) {
      if (data.image?.kind === 'upload' && typeof data.image.storage_path === 'string' && data.image.storage_path) image = { kind: 'upload', storage_path: data.image.storage_path };
      else if (data.image?.kind === 'source' && /^https?:\/\//i.test(data.image.url || '')) image = { kind: 'source', url: data.image.url, source_url: typeof data.image.source_url === 'string' ? data.image.source_url : null };
      else return null;
    }
    return { kind: KIND, version: 1, pod_id: data.pod_id, post_id: data.post_id, platform: data.platform, headline: data.headline,
      call_to_action: data.call_to_action, content_snapshot: data.content_snapshot, approved_at: iso(data.approved_at), image };
  } catch { return null; }
}

export function attachApprovedCalendarCreatives(items, { podId, posts = [], preferences = [], assets = [], sourceMedia = [] } = {}) {
  const candidates = creativeImageCandidates(assets, sourceMedia);
  // Normalize offsets before the existing per-pod/per-post chronological selector.
  const normalizedPreferences = list(preferences).map((row) => ({ ...row, created_at: iso(row.created_at) || row.created_at }));
  return list(items).map((item) => {
    const plain = { ...item, creative_note: decodeCalendarCreative(item.creative_note) ? null : item.creative_note ?? null };
    const matches = list(posts).filter((post) => post.id && platform(post.platformKey || post.platform) === platform(item.platform) && post.content === item.caption);
    // Ambiguous captions must not select arbitrary artwork.
    if (matches.length !== 1) return plain;
    const post = matches[0];
    const review = latestCreativeReview(normalizedPreferences, podId, post.id);
    if (review?.status !== 'approved' || !creativeReviewIsCurrent(review, post.content) || !iso(review.approved_at)) return plain;
    const selected = review.image ? candidates.find((candidate) => candidate.key === imageReferenceKey(review.image)) : null;
    if (review.image && !selected) return plain;
    const snapshot = decodeCalendarCreative(JSON.stringify({ kind: KIND, version: 1, pod_id: podId, post_id: post.id,
      platform: item.platform, headline: review.headline, call_to_action: review.call_to_action || '', content_snapshot: post.content,
      approved_at: iso(review.approved_at), image: selected?.reference || null }));
    return snapshot ? { ...plain, creative_note: JSON.stringify(snapshot) } : plain;
  });
}

export function resolveCalendarCreative(item, { podId, assets = [], sourceMedia = [] } = {}) {
  const snapshot = decodeCalendarCreative(item?.creative_note);
  if (!snapshot || snapshot.pod_id !== podId || snapshot.content_snapshot !== item.caption || platform(snapshot.platform) !== platform(item.platform)) return null;
  const candidate = snapshot.image ? creativeImageCandidates(assets, sourceMedia).find((image) => image.key === imageReferenceKey(snapshot.image)) : null;
  if (snapshot.image && !candidate) return null;
  return { snapshot, imageUrl: candidate?.url || null, imageAlt: candidate?.label || '', imageRole: candidate?.role || null };
}
