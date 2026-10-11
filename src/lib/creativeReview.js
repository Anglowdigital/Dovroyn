const list = (value) => Array.isArray(value) ? value : [];
const safeImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^blob:/.test(value) || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(value) || /^\/(?!\/)/.test(value));

export function creativeImageCandidates(assets, sourceMedia) {
  const uploads = list(assets).filter((asset) => asset.storagePath && safeImage(asset.preview) && asset.assetRole !== 'video' && !/\.(mp4|mov|webm|m4v|pdf)$/i.test(asset.name || asset.storagePath) && (!asset.type || asset.type.startsWith('image/'))).map((asset) => ({
    key: `upload:${asset.storagePath}`, url: asset.preview, label: asset.name || 'Uploaded image',
    role: asset.assetRole, reference: { kind: 'upload', storage_path: asset.storagePath },
  }));
  const sources = list(sourceMedia).filter((media) => /^https?:\/\//i.test(media.url || '') && media.approval_status !== 'rejected' && media.role !== 'video').map((media) => ({
    key: `source:${media.url}`, url: media.url, label: media.alt || 'Source image', role: media.role === 'brand_logo' ? 'logo' : media.role,
    reference: { kind: 'source', url: media.url, source_url: media.source_url || null },
  }));
  return [...new Map([...uploads, ...sources].map((item) => [item.key, item])).values()];
}

export function imageReferenceKey(reference) {
  return reference?.kind === 'upload' ? `upload:${reference.storage_path}` : reference?.kind === 'source' ? `source:${reference.url}` : '';
}

export function latestCreativeReview(preferences, podId, postId) {
  return list(preferences).map((row, index) => ({ row, index })).filter(({ row }) => row.pod_id === podId && row.active !== false && row.preference_type === 'creative_review')
    .sort((a, b) => (Date.parse(b.row.created_at) || 0) - (Date.parse(a.row.created_at) || 0) || b.index - a.index)
    .map(({ row }) => { try { return typeof row.preference_value === 'string' ? JSON.parse(row.preference_value) : row.preference_value; } catch { return null; } })
    .find((value) => value?.post_id === postId) || null;
}

export function initialCreativeHeadline(content = '') {
  const firstSentence = String(content).trim().match(/^[\s\S]*?(?:[.!?](?=\s|$)|\n|$)/)?.[0] || '';
  return firstSentence.trim().slice(0, 140).trim();
}

export function creativeReviewIsCurrent(review, content = '') {
  return Boolean(review && review.content_snapshot === content);
}

export function creativeReviewPayload(postId, headline, cta, selected, approved, content = '') {
  if (!postId || !headline.trim()) throw new Error('Add a headline before saving this creative.');
  return { post_id: postId, headline: headline.trim(), call_to_action: cta.trim(), image: selected?.reference || null,
    content_snapshot: content, status: approved ? 'approved' : 'draft', approved_at: approved ? new Date().toISOString() : null };
}
