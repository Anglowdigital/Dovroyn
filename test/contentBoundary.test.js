import test from 'node:test';
import assert from 'node:assert/strict';
import contentHandler from '../api/ai/content.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('content handler blocks an unapproved pod before allowance reservation or OpenAI', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.VITE_SUPABASE_URL;
  const originalKey = process.env.VITE_SUPABASE_ANON_KEY;
  const calls = [];
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';

  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/auth/v1/user')) return jsonResponse({ id: 'user-one' });
    if (target.includes('/rest/v1/pods?')) {
      return jsonResponse([{ id: 'pod-one', status: 'awaiting_direction', accepted_tone: null }]);
    }
    if (target.includes('/rest/v1/subscriptions?')) {
      return jsonResponse([{
        tier: 'growth',
        status: 'active',
        current_period_end: '2099-01-01T00:00:00.000Z',
        monthly_content_days: 20,
        max_pods: 3,
        weekly_posting_days: 5,
      }]);
    }
    if (target.includes('/rest/v1/pod_analysis?')) {
      return jsonResponse([{ brand_summary: 'Saved analysis', social_recommendations: '["instagram"]' }]);
    }
    if (target.includes('/rest/v1/pod_preferences?')) return jsonResponse([]);
    throw new Error(`Unexpected network call: ${target}`);
  };

  const result = { status: null, body: null, headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(value) { result.status = value; return response; },
    json(value) { result.body = value; return value; },
  };

  try {
    await contentHandler({
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: { podId: 'pod-one', platforms: ['instagram'], contentDay: '2026-09-30' },
    }, response);

    assert.equal(result.status, 409);
    assert.match(result.body.error, /Approve the pod direction/);
    assert.equal(calls.some((url) => url.includes('reserve_content_day')), false);
    assert.equal(calls.some((url) => url.includes('api.openai.com')), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
    else process.env.VITE_SUPABASE_ANON_KEY = originalKey;
  }
});

test('content handler rejects a legacy or stale approval that does not match the latest direction', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.VITE_SUPABASE_URL;
  const originalKey = process.env.VITE_SUPABASE_ANON_KEY;
  const calls = [];
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';

  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/auth/v1/user')) return jsonResponse({ id: 'user-two' });
    if (target.includes('/rest/v1/pods?')) {
      return jsonResponse([{ id: 'pod-two', status: 'direction_locked', accepted_tone: 'Previously approved tone' }]);
    }
    if (target.includes('/rest/v1/subscriptions?')) {
      return jsonResponse([{
        tier: 'growth',
        status: 'active',
        current_period_end: '2099-01-01T00:00:00.000Z',
        monthly_content_days: 20,
        max_pods: 3,
        weekly_posting_days: 5,
      }]);
    }
    if (target.includes('/rest/v1/pod_analysis?')) {
      return jsonResponse([{ brand_summary: 'Saved analysis', social_recommendations: '["instagram"]' }]);
    }
    if (target.includes('/rest/v1/pod_preferences?')) {
      return jsonResponse([{
        preference_type: 'brand_direction',
        preference_value: { value: 'New unapproved direction' },
        active: true,
        created_at: '2026-09-30T01:00:00.000Z',
      }]);
    }
    throw new Error(`Unexpected network call: ${target}`);
  };

  const result = { status: null, body: null, headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(value) { result.status = value; return response; },
    json(value) { result.body = value; return value; },
  };

  try {
    await contentHandler({
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: { podId: 'pod-two', platforms: ['instagram'], contentDay: '2026-09-30' },
    }, response);

    assert.equal(result.status, 409);
    assert.match(result.body.error, /Approve the pod direction/);
    assert.equal(calls.some((url) => url.includes('reserve_content_day')), false);
    assert.equal(calls.some((url) => url.includes('api.openai.com')), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
    else process.env.VITE_SUPABASE_ANON_KEY = originalKey;
  }
});
