import { createOpenAIResponse, getOpenAIClientError } from './openai.js';
import { createBedrockResponse } from './bedrock.js';

const PROVIDERS = new Set(['openai', 'bedrock']);
const BEDROCK_RETRYABLE = new Set(['ThrottlingException', 'ServiceQuotaExceededException', 'ServiceUnavailableException', 'InternalServerException', 'ModelTimeoutException', 'AbortError', 'TimeoutError']);

function canUseFallback(error) {
  if (error?.provider === 'bedrock') return BEDROCK_RETRYABLE.has(error.code);
  return error?.provider === 'openai'
    && (error.status === 429 || error.status >= 500 || ['missing_api_key', 'transport_error'].includes(error.code));
}

export async function createAIResponse(body, {
  workload, env = process.env, openai = createOpenAIResponse, bedrock = createBedrockResponse,
} = {}) {
  const primary = String(env[`AI_${workload}_PROVIDER`] || env.AI_PROVIDER || 'openai').trim().toLowerCase();
  const fallback = String(env.AI_FALLBACK_PROVIDER || '').trim().toLowerCase();
  if (!PROVIDERS.has(primary) || (fallback && !PROVIDERS.has(fallback))) {
    throw Object.assign(new Error('The AI service is temporarily unavailable.'), { provider: 'ai', code: 'invalid_configuration', status: 503 });
  }
  const invoke = (provider) => provider === 'bedrock' ? bedrock(body, { workload, env }) : openai(body);
  try {
    return await invoke(primary);
  } catch (error) {
    // At most one fallback, only when explicitly enabled. Never bypass a model
    // refusal, failed schema, unsafe image, invalid request or ownership check.
    if (!fallback || fallback === primary || !canUseFallback(error)) throw error;
    console.warn('dovroyn_ai_fallback', { from: primary, to: fallback, workload });
    return invoke(fallback);
  }
}

export function getAIClientError(error, messages) {
  if (error?.provider === 'openai') return getOpenAIClientError(error, messages);
  if (!['bedrock', 'ai'].includes(error?.provider)) return null;
  if (error.code === 'ServiceQuotaExceededException') {
    return { status: 503, message: "Dovroyn's AI service has reached a usage limit. Please contact Dovroyn support." };
  }
  return { status: error.status === 429 ? 429 : 503, message: error.status === 429 ? messages.busyMessage : messages.unavailableMessage };
}
