const MAX_CONTEXT_CHARACTERS = 24000;
const MAX_PREFERENCE_CHARACTERS = 8000;
const PREFERENCE_HEADING = 'User corrections and preferences:';

function cleanText(value, maxLength = 3000) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function buildPodAiContext({ pod, analysis, sources = [], preferences = [] }) {
  const canonicalSources = sources.filter((source) => {
    if (!source.source_url) return true;
    if (!pod?.source_url) return true;
    return source.source_url === pod?.source_url;
  });
  const sourceLines = canonicalSources.slice(0, 12).map((source, index) => [
    `Source ${index + 1}`,
    cleanText(source.source_type || 'source', 100),
    cleanText(source.source_url, 1000),
    cleanText(source.notes, 2500),
  ].filter(Boolean).join(' | '));
  const preferenceCandidates = preferences.slice(-20).map((preference, index) => [
    `Preference ${index + 1}`,
    cleanText(preference.preference_type, 100),
    cleanText(preference.preference_value, 1200),
  ].filter(Boolean).join(' | '));
  const preferenceLines = [];
  let preferenceCharacters = PREFERENCE_HEADING.length;
  // Reserve whole newest entries, then restore chronological presentation.
  for (let index = preferenceCandidates.length - 1; index >= 0; index -= 1) {
    const line = preferenceCandidates[index];
    if (preferenceCharacters + line.length + 1 > MAX_PREFERENCE_CHARACTERS) break;
    preferenceLines.push(line);
    preferenceCharacters += line.length + 1;
  }
  preferenceLines.reverse();

  return [
    `Pod ID: ${cleanText(pod?.id, 100)}`,
    `Pod name: ${cleanText(pod?.pod_name, 300) || 'Not supplied'}`,
    `Brand: ${cleanText(pod?.brand_name, 300) || 'Not supplied'}`,
    `Pod type: ${cleanText(pod?.pod_type, 100) || 'Not supplied'}`,
    `Target region: ${cleanText(pod?.target_country, 200) || 'Not supplied'}`,
    `Primary website: ${cleanText(pod?.source_url, 1000) || 'Not supplied'}`,
    `Approved tone: ${cleanText(pod?.accepted_tone || analysis?.tone, 1000) || 'Not approved yet'}`,
    `Approved strategy: ${cleanText(pod?.accepted_strategy, 1500) || 'Not approved yet'}`,
    `Brand summary: ${cleanText(analysis?.brand_summary, 2500) || 'No saved analysis'}`,
    `Audience: ${cleanText(analysis?.audience, 1500) || 'Not supplied'}`,
    `Offer: ${cleanText(analysis?.offer_direction, 1500) || 'Not supplied'}`,
    `Campaign angles: ${cleanText(analysis?.campaign_angles, 2000) || 'Not supplied'}`,
    preferenceLines.length ? `${PREFERENCE_HEADING}\n${preferenceLines.join('\n')}` : `${PREFERENCE_HEADING} none saved`,
    sourceLines.length ? `Pod sources:\n${sourceLines.join('\n')}` : 'Pod sources: none saved',
  ].join('\n').slice(0, MAX_CONTEXT_CHARACTERS);
}
