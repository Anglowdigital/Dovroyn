import { createSafetyIdentifier, extractOutputText, createOpenAIResponse, resolveOpenAIModel } from '../_lib/openai.js';
import { getBearerToken, readJsonBody, requirePost, sendJson } from '../_lib/http.js';
import { checkRateLimit } from '../_lib/rateLimit.js';
import {
  loadActiveSubscription,
  loadLatestPodDirectionPreference,
  loadOwnedPod,
  loadPodAnalysis,
  releaseContentDay,
  reserveContentDay,
  verifySupabaseUser,
} from '../_lib/supabaseAuth.js';
import { formatPlatformPost } from '../../src/lib/podEngine.js';
import { getPlatform } from '../../src/lib/platforms.js';
import { MARKETING_TRUTH_RULES } from '../_lib/marketingTruth.js';
import { hasApprovedPodDirection } from '../_lib/agentSafety.js';

const ALLOWED_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'youtube_shorts', 'linkedin', 'x', 'threads', 'pinterest', 'reddit', 'whatsapp', 'telegram', 'discord', 'email', 'google_business', 'google_ads', 'meta_ads', 'blog'];

const CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    posts: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          platform: { type: 'string', enum: ALLOWED_PLATFORMS },
          body: { type: 'string' },
          callToAction: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        },
        required: ['platform', 'body', 'callToAction', 'keywords'],
      },
    },
  },
  required: ['posts'],
};

function parseStoredList(value) {
  try {
    const result = JSON.parse(value || '[]');
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (!requirePost(req, res)) return;
  let reservation = null;
  let accessToken;
  let podId;
  let generationDate;

  try {
    accessToken = getBearerToken(req);
    const user = await verifySupabaseUser(accessToken);
    if (!user) return sendJson(res, 401, { error: 'Sign in again before generating content.' });

    const rate = checkRateLimit(`pod-content:${user.id}`, { limit: 30, windowMs: 60 * 60 * 1000 });
    if (!rate.allowed) return sendJson(res, 429, { error: 'This account has reached the temporary hourly content limit.' });

    const body = readJsonBody(req);
    podId = body.podId;
    generationDate = /^\d{4}-\d{2}-\d{2}$/.test(body.contentDay || '')
      ? body.contentDay
      : new Date().toISOString().slice(0, 10);
    if (!podId) return sendJson(res, 400, { error: 'A pod ID is required.' });

    const [pod, subscription, analysis, latestDirection] = await Promise.all([
      loadOwnedPod(accessToken, podId),
      loadActiveSubscription(accessToken, user.id),
      loadPodAnalysis(accessToken, podId),
      loadLatestPodDirectionPreference(accessToken, podId),
    ]);
    if (!pod) return sendJson(res, 404, { error: 'Pod not found.' });
    if (!subscription) return sendJson(res, 402, { error: 'An active paid subscription is required for AI generation.' });
    if (!analysis) return sendJson(res, 409, { error: 'Approve and save the pod analysis before generating content.' });
    if (!hasApprovedPodDirection(pod, latestDirection ? [latestDirection] : [])) {
      return sendJson(res, 409, { error: 'Approve the pod direction before generating content.' });
    }

    const requestedPlatforms = (Array.isArray(body.platforms) ? body.platforms : parseStoredList(analysis.social_recommendations))
      .filter((key) => ALLOWED_PLATFORMS.includes(key))
      .slice(0, 8);
    if (!requestedPlatforms.length) return sendJson(res, 400, { error: 'Choose at least one supported platform.' });

    reservation = await reserveContentDay(accessToken, podId, generationDate);
    if (!reservation.allowed) {
      const message = reservation.reason === 'outside_allowance_period'
        ? `Choose a content day inside the current paid allowance period (${reservation.startsOn} to ${reservation.endsOn}).`
        : `This plan has used all ${reservation.limit} content days in the current allowance month.`;
      return sendJson(res, 402, { error: message, allowance: reservation });
    }

    const platformGuidance = requestedPlatforms.map((key) => {
      const platform = getPlatform(key);
      return `${key}: ${platform?.rules?.contentStyle}; hashtag style ${platform?.rules?.hashtagStyle}.`;
    }).join('\n');
    const response = await createOpenAIResponse({
      model: resolveOpenAIModel('OPENAI_CONTENT_MODEL'),
      safety_identifier: createSafetyIdentifier(user.id),
      reasoning: { effort: 'low' },
      instructions: [
        'You create social and owned-channel content for one private Dovroyn pod.',
        'Use only the supplied approved brand direction. Do not invent offers, guarantees, research, results, or urgency.',
        'Create exactly one distinct draft for every requested platform and no unrequested platforms.',
        'Make each draft native to that platform rather than copying the same caption.',
        'Return useful plain keywords without # symbols; Dovroyn will enforce each platform hashtag rule after generation.',
        MARKETING_TRUTH_RULES,
        platformGuidance,
      ].join('\n'),
      input: [
        `Brand summary: ${analysis.brand_summary || ''}`,
        `Approved tone: ${pod.accepted_tone || analysis.tone || ''}`,
        `Audience: ${analysis.audience || ''}`,
        `Offer: ${analysis.offer_direction || ''}`,
        `Campaign opportunity: ${analysis.campaign_angles || ''}`,
        `Content pillars: ${parseStoredList(analysis.content_ideas).join(', ')}`,
        `Requested platforms: ${requestedPlatforms.join(', ')}`,
        `Content day: ${generationDate}`,
        `Additional user direction: ${String(body.direction || '').slice(0, 1500) || 'None'}`,
      ].join('\n'),
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'dovroyn_platform_content', strict: true, schema: CONTENT_SCHEMA } },
      max_output_tokens: 8000,
    });

    const generated = JSON.parse(extractOutputText(response)).posts;
    const byPlatform = new Map(generated.map((post) => [post.platform, post]));
    const posts = requestedPlatforms.map((platformKey) => {
      const draft = byPlatform.get(platformKey);
      if (!draft) throw new Error(`The model omitted ${platformKey}.`);
      return formatPlatformPost({
        platformKey,
        body: draft.body,
        keywords: draft.keywords,
        callToAction: draft.callToAction,
      });
    });
    return sendJson(res, 200, { posts, contentDay: generationDate, allowance: reservation });
  } catch (error) {
    if (reservation?.allowed && !reservation.alreadyReserved && accessToken && podId && generationDate) {
      await releaseContentDay(accessToken, podId, generationDate).catch(() => {});
    }
    const status = error.status === 429 ? 429 : 503;
    return sendJson(res, status, { error: status === 429 ? 'AI capacity is busy. Please try again shortly.' : (error.message || 'Content generation is temporarily unavailable.') });
  }
}
