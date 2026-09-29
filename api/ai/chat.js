import { createSafetyIdentifier, extractOutputText, createOpenAIResponse, resolveOpenAIModel } from '../_lib/openai.js';
import { readJsonBody, requirePost, sendJson } from '../_lib/http.js';
import { checkRateLimit, requestIdentity } from '../_lib/rateLimit.js';
import { MARKETING_TRUTH_RULES } from '../_lib/marketingTruth.js';

const MAX_QUESTION_LENGTH = 800;

const DEMO_POD_CONTEXT = [
  'This request comes from the Aurora Skincare demo pod.',
  'Aurora is a premium Australian skincare brand launching a winter hydration and skin-barrier bundle.',
  'Its approved tone is expert, reassuring, and modern luxury.',
  'Its audience is Australian adults researching hydration, sensitive skin, and barrier repair.',
].join(' ');

export function buildPublicAssistantInstructions({ demoPod = false } = {}) {
  return [
    demoPod ? 'You are the AI inside Dovroyn\'s Aurora Skincare demo pod.' : 'You are Dovroyn\'s public marketing assistant.',
    'Answer the user\'s exact question immediately. Do not replace the answer with a vague brand-direction summary.',
    'When asked where to advertise, name specific websites or platforms, explain why each fits, and identify the strongest starting choices.',
    'Answer general marketing questions and accurate product questions concisely.',
    'Dovroyn uses separate AI marketing pods for each website, brand, offer, or campaign.',
    'A pod can analyse sources, propose a brand direction, generate platform-specific content, and organise assets, calendars, campaigns, analytics, collaborations, coming-soon pages, and budgets.',
    'Never claim an external social account is connected or that Dovroyn can publish until that provider integration is configured and the user authorises it.',
    'Never request passwords, API keys, payment details, or private customer data.',
    demoPod ? DEMO_POD_CONTEXT : '',
    'When useful, end with one practical next step.',
  ].filter(Boolean).join('\n');
}

export default async function handler(req, res) {
  if (!requirePost(req, res)) return;

  const rate = checkRateLimit(`landing-chat:${requestIdentity(req)}`, { limit: 8, windowMs: 10 * 60 * 1000 });
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  if (!rate.allowed) return sendJson(res, 429, { error: 'Please wait a few minutes before asking another question.' });

  try {
    const { question, demoPod } = readJsonBody(req);
    const cleanQuestion = String(question || '').trim();
    if (!cleanQuestion || cleanQuestion.length > MAX_QUESTION_LENGTH) {
      return sendJson(res, 400, { error: `Question must be between 1 and ${MAX_QUESTION_LENGTH} characters.` });
    }

    const response = await createOpenAIResponse({
      model: resolveOpenAIModel('OPENAI_CHAT_MODEL'),
      safety_identifier: createSafetyIdentifier(`landing:${requestIdentity(req)}`),
      reasoning: { effort: 'low' },
      instructions: [buildPublicAssistantInstructions({ demoPod: demoPod === true }), MARKETING_TRUTH_RULES].join('\n\n'),
      input: cleanQuestion,
      text: { verbosity: 'low' },
      max_output_tokens: 8000,
    });

    return sendJson(res, 200, { answer: extractOutputText(response) });
  } catch (error) {
    const status = error.status === 429 ? 429 : 503;
    return sendJson(res, status, { error: status === 429 ? 'The assistant is busy. Please try again shortly.' : 'The live assistant is temporarily unavailable.' });
  }
}
