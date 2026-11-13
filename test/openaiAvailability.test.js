import test from 'node:test';
import assert from 'node:assert/strict';
import analyzeHandler from '../api/ai/analyze.js';
import contentHandler from '../api/ai/content.js';
import podChatHandler from '../api/ai/pod-chat.js';

const PROVIDER_DETAIL = 'Private provider detail: sk-test-not-a-real-key, org-private, project-private';
let requestNumber = 0;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function invokePodAi(handler, providerError = null, overrides = {}) {
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'OPENAI_API_KEY', 'OPENAI_CONTENT_MODEL', 'OPENAI_POD_MODEL']
    .map((key) => [key, process.env[key]]));
  const providerCalls = [];
  const releasedDays = [];
  const savedMessages = [];
  const savedAnalyses = [];
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  if (overrides.missingApiKey) delete process.env.OPENAI_API_KEY;
  process.env.OPENAI_CONTENT_MODEL = 'test-content-model';
  process.env.OPENAI_POD_MODEL = 'test-pod-model';

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return jsonResponse({ id: 'availability-owner' });
    if (target.includes('/rest/v1/pods?')) return jsonResponse([{
      id: 'availability-pod', pod_name: 'Fictional flower shop', status: 'direction_locked', accepted_tone: 'Warm and practical',
      source_type: 'photos', source_url: null, source_locked_at: null, ...overrides.pod,
    }]);
    if (target.includes('/rest/v1/subscriptions?')) return jsonResponse([{
      tier: 'starter', status: 'active', current_period_end: '2099-01-01T00:00:00.000Z',
      monthly_content_days: 10, max_pods: 1, weekly_posting_days: 2,
    }]);
    if (target.includes('/rest/v1/pod_analysis?')) return jsonResponse([{
      brand_summary: 'Fictional flower shop', tone: 'Warm and practical',
      content_ideas: '["Seasonal flowers"]', social_recommendations: '["instagram"]',
    }]);
    if (target.includes('/rest/v1/pod_preferences?') || target.includes('/rest/v1/pod_sources?')) return jsonResponse([]);
    if (target.includes('/rest/v1/pod_ai_messages?')) return jsonResponse([]);
    if (target.endsWith('/rest/v1/pod_ai_messages')) {
      savedMessages.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (target.endsWith('/rest/v1/rpc/reserve_content_day')) {
      return jsonResponse({ allowed: true, alreadyReserved: false, used: 1, limit: 10 });
    }
    if (target.endsWith('/rest/v1/rpc/release_content_day')) {
      releasedDays.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    if (target.endsWith('/rest/v1/rpc/finalize_pod_analysis')) {
      savedAnalyses.push(JSON.parse(options.body));
      return jsonResponse('2026-11-14T00:00:00.000Z');
    }
    if (target === 'https://api.openai.com/v1/responses') {
      providerCalls.push(JSON.parse(options.body));
      if (providerError) return jsonResponse({ error: { ...providerError, message: PROVIDER_DETAIL } }, providerError.status);
      const text = handler === contentHandler
        ? JSON.stringify({ posts: [{ platform: 'instagram', body: 'Seasonal flowers for your day.', callToAction: 'Explore the collection.', keywords: ['flowers'] }] })
        : 'Start with one useful flower care tip.';
      return jsonResponse({ status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text }] }] });
    }
    throw new Error(`Unexpected network call: ${target}`);
  };

  const result = {};
  const response = {
    setHeader() {},
    status(value) { result.status = value; return response; },
    json(value) { result.body = value; return value; },
  };
  try {
    await handler({
      method: 'POST', headers: { authorization: 'Bearer test-user-token', 'x-forwarded-for': `198.51.100.${++requestNumber}` },
      body: { podId: 'availability-pod', platforms: ['instagram'], contentDay: '2026-11-14', question: 'Suggest one post.', imageUrls: ['https://assets.example/flowers.png'], ...overrides.body },
    }, response);
    return { ...result, providerCalls, releasedDays, savedMessages, savedAnalyses };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

for (const [name, handler] of [['content', contentHandler], ['pod chat', podChatHandler], ['analysis', analyzeHandler]]) {
  for (const providerError of [
    { code: 'insufficient_quota', type: 'insufficient_quota' },
    { code: 'credit_balance_exhausted', type: 'insufficient_quota' },
    { code: 'organization_spend_limit_exceeded' },
    { code: 'project_spend_limit_exceeded' },
    { code: 'organization_usage_limit_exceeded' },
    { type: 'insufficient_quota' },
  ]) {
    test(`${name} identifies ${providerError.code || 'quota type without a code'} as a service billing or usage limit`, async () => {
      const result = await invokePodAi(handler, { status: 429, ...providerError });
      assert.equal(result.status, 503);
      assert.match(result.body.error, /billing|credit|usage limit/i);
      assert.match(result.body.error, /contact Dovroyn support/i);
      assert.doesNotMatch(result.body.error, /busy|try again shortly|sk-test|org-private|project-private/);
      assert.equal(result.providerCalls.length, 1);
      assert.equal(result.releasedDays.length, handler === contentHandler ? 1 : 0);
      assert.deepEqual(result.savedMessages, []);
      assert.deepEqual(result.savedAnalyses, []);
    });
  }

  for (const code of ['rate_limit_exceeded', 'slow_down']) {
    test(`${name} retains the retry message for ${code}`, async () => {
      const result = await invokePodAi(handler, { status: 429, code, type: 'rate_limit_error' });
      assert.equal(result.status, 429);
      assert.match(result.body.error, /busy.*try again shortly/i);
      assert.doesNotMatch(result.body.error, /billing|credit|sk-test|org-private|project-private/);
      assert.equal(result.releasedDays.length, handler === contentHandler ? 1 : 0);
    });
  }

  test(`${name} keeps provider authentication details out of the client response`, async () => {
    const result = await invokePodAi(handler, { status: 401, code: 'invalid_api_key', type: 'invalid_request_error' });
    assert.equal(result.status, 503);
    assert.match(result.body.error, /temporarily unavailable/i);
    assert.doesNotMatch(result.body.error, /sk-test|org-private|project-private|Private provider detail/);
    assert.equal(result.releasedDays.length, handler === contentHandler ? 1 : 0);
    assert.deepEqual(result.savedAnalyses, []);
  });

  // Analysis success and provenance persistence are covered in analyzeBoundary.test.js.
  if (handler === analyzeHandler) continue;
  test(`${name} still returns successful generated output`, async () => {
    const result = await invokePodAi(handler);
    assert.equal(result.status, 200);
    assert.equal(result.providerCalls.length, 1);
    assert.equal(result.providerCalls[0].store, false);
    assert.equal(result.providerCalls[0].model, handler === contentHandler ? 'test-content-model' : 'test-pod-model');
    assert.deepEqual(result.releasedDays, []);
    if (handler === contentHandler) {
      assert.equal(result.body.posts.length, 1);
      assert.equal(result.body.posts[0].platformKey, 'instagram');
      assert.match(result.body.posts[0].content, /Seasonal flowers/);
    } else {
      assert.equal(result.body.answer, 'Start with one useful flower care tip.');
      assert.equal(result.body.memorySaved, true);
      assert.equal(result.savedMessages.length, 1);
    }
  });
}

test('analysis missing provider configuration is a safe service error', async () => {
  const result = await invokePodAi(analyzeHandler, null, { missingApiKey: true });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /temporarily unavailable/i);
  assert.doesNotMatch(result.body.error, /OPENAI_API_KEY|sk-test|org-private|project-private/);
  assert.deepEqual(result.providerCalls, []);
  assert.deepEqual(result.savedAnalyses, []);
});

for (const [name, overrides, status, message] of [
  ['missing pod', { body: { podId: null } }, 400, /A pod ID is required/],
  ['locked source', { pod: { source_locked_at: '2026-11-13T00:00:00.000Z' } }, 409, /source is locked/],
  ['missing source URL', { pod: { source_type: 'website', source_url: null } }, 422, /Save the one primary source URL/],
]) {
  test(`analysis preserves the local ${name} validation error`, async () => {
    const result = await invokePodAi(analyzeHandler, null, overrides);
    assert.equal(result.status, status);
    assert.match(result.body.error, message);
    assert.deepEqual(result.providerCalls, []);
    assert.deepEqual(result.savedAnalyses, []);
  });
}
