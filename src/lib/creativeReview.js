const list = (value) => Array.isArray(value) ? value : [];
const safeImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^blob:/.test(value) || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(value) || /^\/(?!\/)/.test(value));
export const CREATIVE_REVIEW_COMPOSITION_VERSION = 'meta_organic_creative_composition_v2';
export const CREATIVE_REVIEW_FONT_CONTRACT = 'system-ui-safe-v1';
export const CREATIVE_REVIEW_LAYOUT = 'meta-organic-portrait-v1';

export function creativeImageCandidates(assets, sourceMedia) {
  const uploads = list(assets).filter((asset) => asset.storagePath && safeImage(asset.preview) && asset.assetRole !== 'video' && !/\.(mp4|mov|webm|m4v|pdf)$/i.test(asset.name || asset.storagePath) && (!asset.type || asset.type.startsWith('image/'))).map((asset) => ({
    key: `upload:${asset.storagePath}`, url: asset.preview, label: asset.name || 'Uploaded image',
    role: asset.assetRole, reference: { kind: 'upload', storage_path: asset.storagePath },
    evidence: asset.sourceEvidence || (asset.sha256 || asset.hash || asset.objectVersion || asset.object_version ? {
      kind: 'upload',
      storage_path: asset.storagePath,
      hash: asset.sha256 || asset.hash || null,
      object_version: asset.objectVersion || asset.object_version || null,
      media_type: asset.type || asset.media_type || null,
      byte_length: asset.size || asset.file_size || null,
    } : null),
  }));
  const sources = list(sourceMedia).filter((media) => /^https?:\/\//i.test(media.url || '') && media.approval_status !== 'rejected' && media.role !== 'video').map((media) => ({
    key: `source:${media.url}`, url: media.url, label: media.alt || 'Source image', role: media.role === 'brand_logo' ? 'logo' : media.role,
    reference: { kind: 'source', url: media.url, source_url: media.source_url || null },
    evidence: media.sourceEvidence || (media.sha256 || media.hash || media.revision || media.source_revision ? {
      kind: 'source',
      url: media.url,
      source_url: media.source_url || null,
      hash: media.sha256 || media.hash || null,
      revision: media.revision || media.source_revision || null,
      media_type: media.media_type || media.type || null,
      byte_length: media.byte_length || media.size || null,
    } : null),
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

export function creativeReviewPayload(postId, headline, cta, selected, approved, content = '', options = {}) {
  if (!postId || !headline.trim()) throw new Error('Add a headline before saving this creative.');
  const brandName = typeof options.brandName === 'string' ? options.brandName.trim().slice(0, 120) : '';
  const imageRole = selected?.role === 'logo' ? 'logo' : selected?.reference ? 'image' : 'typography';
  const sourceEvidence = selected?.evidence || (selected ? null : { kind: 'typography_only', identity: 'typography-only' });
  return { post_id: postId, headline: headline.trim(), call_to_action: cta.trim(), image: selected?.reference || null,
    artwork_contract_version: CREATIVE_REVIEW_COMPOSITION_VERSION,
    composition: {
      version: CREATIVE_REVIEW_COMPOSITION_VERSION,
      layout: CREATIVE_REVIEW_LAYOUT,
      font_contract: CREATIVE_REVIEW_FONT_CONTRACT,
      brand_name: brandName,
      image_role: imageRole,
      typography_only: !selected,
      headline: headline.trim(),
      call_to_action: cta.trim(),
    },
    source_evidence: sourceEvidence,
    content_snapshot: content, status: approved ? 'approved' : 'draft', approved_at: approved ? new Date().toISOString() : null };
}
