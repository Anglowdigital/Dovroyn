import { createHash } from 'node:crypto';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const DEFAULT_OPENAI_MODEL = 'gpt-6-astra';

export function resolveOpenAIModel(workloadVariable, env = process.env) {
  const workloadModel = String(env?.[workloadVariable] || '').trim();
  const sharedModel = String(env?.OPENAI_MODEL || '').trim();
  return workloadModel || sharedModel || DEFAULT_OPENAI_MODEL;
}

export function createSafetyIdentifier(userId) {
  const digest = createHash('sha256').update(String(userId || 'anonymous')).digest('hex').slice(0, 48);
  return `dovroyn_${digest}`;
}

export async function createOpenAIResponse(body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('dovroyn_openai_failure', { category: 'missing_api_key' });
    const error = new Error('OPENAI_API_KEY is not configured.');
    error.code = 'missing_api_key';
    throw error;
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ store: false, ...body }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'OpenAI request failed.');
    error.status = response.status;
    error.code = payload?.error?.code || 'openai_request_failed';
    error.type = payload?.error?.type || 'openai_error';
    console.error('dovroyn_openai_failure', {
      category: 'provider_error',
      status: error.status,
      code: error.code,
      type: error.type,
    });
    throw error;
  }
  return payload;
}

export function extractOutputText(response) {
  if (response?.error) throw new Error('The model response failed.');
  if (response?.status != null && response.status !== 'completed') {
    throw new Error('The model response did not complete.');
  }

  const textParts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type != null && item.type !== 'message') continue;
    if (item?.status != null && item.status !== 'completed') {
      throw new Error('The model message did not complete.');
    }
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'refusal') throw new Error('The model declined the request.');
      if ((content?.type == null || content.type === 'output_text') && typeof content?.text === 'string') {
        textParts.push(content.text);
      }
    }
  }

  // Inspect every message for refusals and partial output before using the shortcut.
  const text = typeof response?.output_text === 'string' ? response.output_text : textParts.join('');
  if (text.trim()) return text;
  throw new Error('The model returned no text output.');
}
