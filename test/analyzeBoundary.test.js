import test from 'node:test';
import assert from 'node:assert/strict';
import analyzeHandler from '../api/ai/analyze.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('photos-only analysis advertises and accepts image evidence labels without a website label', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.VITE_SUPABASE_URL;
  const originalKey = process.env.VITE_SUPABASE_ANON_KEY;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  let openAIRequest;
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const modelAnalysis = {
    summary: 'A visual outdoor brand.',
    tone: 'Practical and warm',
    audience: 'Outdoor customers',
    offer: 'Durable outdoor goods',
    opportunity: 'Show the products in real settings',
    pillars: ['Product use', 'Materials', 'Customer education'],
    platforms: ['instagram', 'facebook'],
    brand_colours: [
      { name: 'Forest', hex: '#234D20' },
      { name: 'Sand', hex: '#D8C39A' },
      { name: 'Charcoal', hex: '#333333' },
      { name: 'Cream', hex: '#F6F0E4' },
    ],
    geography: ['Australia'],
    evidence: [{ source_type: 'image', source_reference: 'image_1', finding: 'The product is shown outdoors.', confidence: 0.9 }],
    confidence: 0.9,
    personal_data_detected: false,
    personal_data_categories: [],
  };

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return jsonResponse({ id: 'photo-user' });
    if (target.includes('/rest/v1/pods?')) {
      return jsonResponse([{
        id: 'photo-pod',
        pod_name: 'Photo pod',
        brand_name: 'Trail Goods',
        pod_type: 'images',
        source_type: 'photos',
        source_url: null,
        source_locked_at: null,
        target_country: 'Australia',
      }]);
    }
    if (target === 'https://api.openai.com/v1/responses') {
      openAIRequest = JSON.parse(options.body);
      return jsonResponse({
        status: 'completed',
        output: [{
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(modelAnalysis) }],
        }],
      });
    }
    if (target.includes('/rest/v1/rpc/finalize_pod_analysis')) {
      return jsonResponse('2026-09-30T02:00:00.000Z');
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
    await analyzeHandler({
      method: 'POST',
      headers: { authorization: 'Bearer user-token', 'x-forwarded-for': '198.51.100.47' },
      body: { podId: 'photo-pod', imageUrls: ['https://assets.example/photo.jpg'] },
    }, response);

    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.evidence[0].source_reference, 'image_1');
    assert.match(openAIRequest.instructions, /Allowed evidence labels: image_1\./);
    assert.doesNotMatch(openAIRequest.instructions, /Allowed evidence labels:[^.]*website/);
    assert.doesNotMatch(openAIRequest.input[0].content[0].text, /Source label website/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY;
    else process.env.VITE_SUPABASE_ANON_KEY = originalKey;
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
});
