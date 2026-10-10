export const MAX_BRAND_PHOTOS = 5;

export const DOVROYN_POD_PRESET = Object.freeze({
  podName: 'Dovroyn Website Marketing',
  brandName: 'Dovroyn',
  sourceType: 'website',
  sourceUrl: 'https://dovroyn.com',
  description: "Use Dovroyn's public website and approved brand assets as the source of truth. Do not invent customer results, integrations, publishing activity or performance claims.",
  targetCountry: 'Australia',
});

export const POD_SOURCE_TYPES = [
  { value: 'website', label: 'Website', placeholder: 'https://yourbrand.com' },
  { value: 'social', label: 'Social page', placeholder: 'https://instagram.com/yourbrand' },
  { value: 'shopify', label: 'Shopify store', placeholder: 'https://your-store.myshopify.com' },
  { value: 'photos', label: 'Photos only', placeholder: '' },
];

export function sourceNeedsUrl(sourceType) {
  return ['website', 'social', 'shopify'].includes(sourceType);
}

export function validatePodSetup({ sourceType, sourceUrl, logoCount, photoCount }) {
  if (!POD_SOURCE_TYPES.some((source) => source.value === sourceType)) return 'Choose one primary source type.';
  if (sourceNeedsUrl(sourceType) && !String(sourceUrl || '').trim()) return 'Add the one primary URL for this pod.';
  if (sourceType === 'photos' && photoCount < 1) return 'Add at least one brand photo for a photos-only pod.';
  if (logoCount !== 1) return 'Add one brand logo before analysis.';
  if (photoCount > MAX_BRAND_PHOTOS) return `Add no more than ${MAX_BRAND_PHOTOS} brand photos.`;
  return '';
}

