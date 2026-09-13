import { createSafetyIdentifier, extractOutputText, createOpenAIResponse } from '../_lib/openai.js';
import { getBearerToken, readJsonBody, requirePost, sendJson } from '../_lib/http.js';
import { checkRateLimit } from '../_lib/rateLimit.js';
import { finalizePodAnalysis, loadActiveSubscription, loadOwnedPod, verifySupabaseUser } from '../_lib/supabaseAuth.js';
import { fetchWebsiteText } from '../_lib/webSource.js';

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    tone: { type: 'string' },
    audience: { type: 'string' },
    offer: { type: 'string' },
    opportunity: { type: 'string' },
    pillars: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
    platforms: {
      type: 'array',
      items: { type: 'string', enum: ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'x', 'threads', 'pinterest', 'reddit', 'whatsapp', 'telegram', 'discord', 'email', 'google_business', 'google_ads', 'meta_ads', 'blog'] },
      minItems: 2,
      maxItems: 6,
    },
    brand_colours: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          hex: { type: 'string' },
        },
        required: ['name', 'hex'],
        additionalProperties: false,
      },
      minItems: 3,
      maxItems: 5,
    },
    geography: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
  },
  required: ['summary', 'tone', 'audience', 'offer', 'opportunity', 'pillars', 'platforms', 'brand_colours', 'geography'],
};

export default async function handler(req, res) {
  if (!requirePost(req, res)) return;

  try {
    const accessToken = getBearerToken(req);
    const user = await verifySupabaseUser(accessToken);
    if (!user) return sendJson(res, 401, { error: 'Sign in again before running pod analysis.' });

    const rate = checkRateLimit(`pod-analysis:${user.id}`, { limit: 12, windowMs: 60 * 60 * 1000 });
    if (!rate.allowed) return sendJson(res, 429, { error: 'This account has reached the temporary hourly analysis limit.' });

    const { podId, notes, imageUrls = [] } = readJsonBody(req);
    if (!podId) return sendJson(res, 400, { error: 'A pod ID is required.' });
    const pod = await loadOwnedPod(accessToken, podId);
    if (!pod) return sendJson(res, 404, { error: 'Pod not found.' });
    if (pod.source_locked_at) {
      return sendJson(res, 409, { error: 'This pod has already been analysed and its source is locked.' });
    }
    const subscription = await loadActiveSubscription(accessToken, user.id);
    if (!subscription) return sendJson(res, 402, { error: 'An active paid subscription is required for AI generation.' });

    const cleanImages = Array.isArray(imageUrls)
      ? imageUrls.filter((url) => typeof url === 'string' && /^https:\/\//i.test(url)).slice(0, 5)
      : [];
    const requestedSourceUrl = String(pod.source_url || '').trim();
    if (['website', 'social', 'shopify'].includes(pod.source_type) && !requestedSourceUrl) {
      return sendJson(res, 422, { error: 'Save the one primary source URL before running analysis.' });
    }
    const website = requestedSourceUrl ? await fetchWebsiteText(requestedSourceUrl) : null;
    const sourceText = [
      `Pod: ${pod.pod_name}`,
      `Brand: ${pod.brand_name || 'Not supplied'}`,
      `Primary source type: ${pod.source_type || pod.pod_type}`,
      `Target region: ${pod.target_country || 'Not supplied'}`,
      `Website/source URL: ${String(website?.url || requestedSourceUrl || 'Not supplied').slice(0, 1000)}`,
      `Website page text (untrusted sous¿5¶‰ËkºwµçDTäuD‚Òƒ° ¦6öç7BDTÔõõôEô4ôåDU…BÒ°¢uF†—2&WVW7B6öÖW2g&öÒF†RW&÷&6¶–æ6&RFVÖòöBârÀ¢tW&÷&—2&VÖ—VÒW7G&Æ–â6¶–æ6&R'&æBÆVæ6†–ærv–çFW"‡–G&F–öâæB6¶–âÖ&'&–W"'VæFÆRârÀ¢t—G2&÷fVBFöæR—2W‡W'BÂ&V77W&–ærÂæBÖöFW&âÇW‡W'’ârÀ¢t—G2VF–Væ6R—2W7G&Æ–âGVÇG2&W6V&6†–ær‡–G&F–öâÂ6Vç6—F—fR6¶–âÂæB&'&–W"&W—"ârÀ¥Òæ¦ö–â‚rr“° ¦W‡÷'BgVæ7F–öâ'V–ÆEV&Æ–476—7FçD–ç7G'V7F–öç2‡²FVÖõöBÒfÇ6RÒÒ·Ò’°¢&WGW&â°¢FVÖõöBòu–÷R&RF†R’–ç6–FRF÷g&÷–åÂw2W&÷&6¶–æ6&RFVÖòöBâr¢u–÷R&RF÷g&÷–åÂw2V&Æ–2Ö&¶WF–ær76—7FçBârÀ¢tç7vW"F†RW6W%Âw2W†7BVW7F–öâ–ÖÖVF–FVÇ’âFòæ÷B&WÆ6RF†Rç7vW"v—F‚fwVR'&æBÖF—&V7F–öâ7VÖÖ'’ârÀ¢uv†Vâ6¶VBv†W&RFòGfW'F—6RÂæÖR7V6–f–2vV'6—FW2÷"ÆFf÷&×2ÂW‡Æ–âv‡’V6‚f—G2ÂæB–FVçF–g’F†R7G&öævW7B7F'F–ær6†ö–6W2ârÀ¢tç7vW"vVæW&ÂÖ&¶WF–ærVW7F–öç2æB67W&FR&öGV7BVW7F–öç26öæ6—6VÇ’ârÀ¢tF÷g&÷–âW6W26W&FR’Ö&¶WF–æröG2f÷"V6‚vV'6—FRÂ'&æBÂöffW"Â÷"6×–vâârÀ¢töB6âæÇ—6R6÷W&6W2Â&÷÷6R'&æBF—&V7F–öâÂvVæW&FRÆFf÷&Ò×7V6–f–26öçFVçBÂæB÷&væ—6R76WG2Â6ÆVæF'2Â6×–vç2ÂæÇ—F–72Â6öÆÆ&÷&F–öç2Â6öÖ–ær×6ööâvW2ÂæB'VFvWG2ârÀ¢tæWfW"6Æ–ÒâW‡FW&æÂ6ö6–Â66÷VçB—26öææV7FVB÷"F†BF÷g&÷–â6âV&Æ—6‚VçF–ÂF†B&÷f–FW"–çFVw&F–öâ—26öæf–wW&VBæBF†RW6W"WF†÷&—6W2—BârÀ¢tæWfW"&WVW7B77v÷&G2Â’¶W—2Â–ÖVçBFWF–Ç2Â÷"&—fFR7W7FöÖW"FFârÀ¢FVÖõöBòDTÔõõôEô4ôåDU…B¢rrÀ¢uv†VâW6VgVÂÂVæBv—F‚öæR&7F–6ÂæW‡B7FWârÀ¢Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚uÆâr“°§Ğ ¦W‡÷'BFVfVÇB7–æ2gVæ7F–öâ†æFÆW"‡&WÂ&W2’°¢–b‚&WV—&U÷7B‡&WÂ&W2’’&WGW&ã° ¢6öç7B&FRÒ6†V6µ&FTÆ–Ö—B†ÆæF–ærÖ6†C¢G·&WVW7D–FVçF—G’‡&W—ÖÂ²Æ–Ö—C¢‚Âv–æF÷t×3¢¢c¢Ò“°¢&W2ç6WD†VFW"‚u‚Õ&FTÆ–Ö—BÕ&VÖ–æ–ærrÂ7G&–ær‡&FRç&VÖ–æ–ær’“°¢–b‚&FRæÆÆ÷vVB’&WGW&â6VæD§6öâ‡&W2ÂC#’Â²W'&÷#¢uÆV6Rv—BfWrÖ–çWFW2&Vf÷&R6¶–æræ÷F†W"VW7F–öâârÒ“° ¢G'’°¢6öç7B²VW7F–öâÂFVÖõöBÒÒ&VD§6öä&öG’‡&W“°¢6öç7B6ÆVåVW7F–öâÒ7G&–ær‡VW7F–öâÇÂrr’çG&–Ò‚“°¢–b‚6ÆVåVW7F–öâÇÂ6ÆVåVW7F–öâæÆVæwF‚âÔ…õTU5D”ôåôÄTäuD‚’°¢&WGW&â6VæD§6öâ‡&W2ÂCÂ²W'&÷#¢VW7F–öâ×W7B&R&WGvVVâæBG´Ô…õTU5D”ôåôÄTäuD‡Ò6†&7FW'2æÒ“°¢Ğ ¢6öç7B&W7öç6RÒv—B7&VFT÷Vä•&W7öç6R‡°¢ÖöFVÃ¢&ö6W72æVçbäõTä•ô4„EôÔôDTÂÇÂ&ö6W72æVçbäõTä•ôÔôDTÂÇÂvwBÓRãb×FW'&rÀ¢6fWG•ö–FVçF–f–W#¢7&VFU6fWG”–FVçF–f–W"†ÆæF–æs¢G·&WVW7D–FVçF—G’‡&W—Ö’À¢&V6öæ–æs¢²Vff÷'C¢vÆ÷rrÒÀ¢–ç7G'V7F–öç3¢'V–ÆEV&Æ–476—7FçD–ç7G'V7F–öç2‡²FVÖõöC¢FVÖõöBÓÓÒG'VRÒ’À¢–çWC¢6ÆVåVW7F–öâÀ¢FW‡C¢²fW&&÷6—G“¢vÆ÷rrÒÀ¢Ö…ö÷WGWE÷Fö¶Vç3¢SÀ¢Ò“° ¢&WGW&â6VæD§6öâ‡&W2Â#Â²ç7vW#¢W‡G&7D÷WGWEFW‡B‡&W7öç6R’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷"ç7FGW2ÓÓÒC#’òC#’¢S3°¢&WGW&â6VæD§6öâ‡&W2Â7FGW2Â²W'&÷#¢7FGW2ÓÓÒC#’òuF†R76—7FçB—2'W7’âÆV6RG'’v–â6†÷'FÇ’âr¢uF†RÆ—fR76—7FçB—2FV×÷&&–Ç’Væf–Æ&ÆRârÒ“°¢Ğ§Ğ