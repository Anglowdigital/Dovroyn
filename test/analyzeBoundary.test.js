import test from 'node:test';
import assert from 'node:assert/strict';
import analyzeHandler from '../api/ai/analyze.js';
import { mockWebsiteRequest } from './fixtures/mockWebsiteRequest.js';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function richAnalysis(overrides = {}) {
  return {
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
    products_services: ['Outdoor goods'],
    visual_style: 'Natural product photography with practical detail.',
    site_structure: ['Home', 'Products', 'About'],
    best_landing_pages: [],
    weak_pages: [],
    seo_opportunities: ['Create product-led search pages'],
    content_opportunities: ['Publish care and use guides'],
    audience_fit: 'Strong fit for practical Australian outdoor customers.',
    evidence: [{ source_type: 'image', source_reference: 'image_1', finding: 'The product is shown outdoors.', confidence: 0.9 }],
    confidence: 0.9,
    personal_data_detected: false,
    personal_data_categories: [],
    ...overrides,
  };
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

  const modelAnalysis = richAnalysis();

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
    const schema = openAIRequest.text.format.schema;
    for (const field of ['products_services', 'visual_style', 'site_structure', 'best_landing_pages', 'weak_pages', 'seo_opportunities', 'content_opportunities', 'audience_fit']) {
      assert.ok(schema.required.includes(field), `${field} must be required`);
    }
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

test('website analysis supplies bounded labelled pages and user notes to the rich dynamic schema', async (t) => {
  t.after(mockWebsiteRequest());
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.VITE_SUPABASE_URL;
  const originalKey = process.env.VITE_SUPABASE_ANON_KEY;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  let openAIRequest;
  let finalizedPayload;
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const modelAnalysis = richAnalysis({
    products_services: ['Barrier cream', 'Skin consultation'],
    best_landing_pages: [{ source_reference: 'website_page_2', reason: 'Clear product offer' }],
    weak_pages: [{ source_reference: 'website_home', issue: 'The value proposition is below the fold' }],
    evidence: [
      { source_type: 'website', source_reference: 'website_home', finding: 'The home page leads with barrier care.', confidence: 0.9 },
      { source_type: 'user', source_reference: 'user_notes', finding: 'The owner prioritises wholesale growth.', confidence: 0.8 },
    ],
  });

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return jsonResponse({ id: 'website-user' });
    if (target.includes('/rest/v1/pods?')) {
      return jsonResponse([{
        id: 'website-pod',
        pod_name: 'Website pod',
        brand_name: 'Aurora Skin',
        pod_type: 'website',
        source_type: 'website',
        source_url: 'https://8.8.8.8',
        source_locked_at: null,
        target_country: 'Australia',
      }]);
    }
    if (target === 'https://8.8.8.8/' || target === 'https://8.8.8.8') {
      return new Response('<title>Aurora home</title><meta name="description" content="Barrier care"><h1>Calm skin</h1><p>Home source text</p><a href="/products">Products</a>', { headers: { 'content-type': 'text/html' } });
    }
    if (target === 'https://8.8.8.8/products') {
      return new Response('<title>Products</title><h1>Barrier cream</h1><p>Product source text</p>', { headers: { 'content-type': 'text/html' } });
    }
    if (target === 'https://api.openai.com/v1/responses') {
      openAIRequest = JSON.parse(options.body);
      return jsonResponse({
        status: 'completed',
        output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(modelAnalysis) }] }],
      });
    }
    if (target.includes('/rest/v1/rpc/finalize_pod_analysis')) {
      finalizedPayload = JSON.parse(options.body);
      return jsonResponse('2026-10-07T02:00:00.000Z');
    }
    throw new Error(`Unexpected network call: ${target}`);
  };

  const result = { status: null, body: null };
  const response = {
    setHeader() {},
    status(value) { result.status = value; return response; },
    json(value) { result.body = value; return value; },
  };

  try {
    const notes = `${'Wholesale focus. '.repeat(300)}TAIL-MUST-BE-TRIMMED`;
    await analyzeHandler({
      method: 'POST',
      headers: { authorization: 'Bearer user-token', 'x-forwarded-for': '198.51.100.48' },
      body: { podId: 'website-pod', notes, imageUrls: [] },
    }, response);

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.analysis.products_services, ['Barrier cream', 'Skin consultation']);
    assert.equal('pages' in result.body, false);
    assert.equal('website' in result.body, false);
    assert.deepEqual(finalizedPayload.p_analysis, result.body.analysis);
    assert.equal(JSON.stringify(finalizedPayload).includes('Home source text'), false);

    const inputText = openAIRequest.input[0].content[0].text;
    assert.match(inputText, /Source label website_home/);
    assert.match(inputText, /URL: https:\/\/8\.8\.8\.8\//);
    assert.match(inputText, /Title: Aurora home/);
    assert.match(inputText, /Source label website_page_2/);
    assert.match(inputText, /Product source text/);
    assert.match(inputText, /Source label user_notes/);
    assert.doesNotMatch(inputText, /TAIL-MUST-BE-TRIMMED/);
    assert.match(openAIRequest.instructions, /website_home, website_page_2, user_notes/);

    const schema = openAIRequest.text.format.schema;
    assert.deepEqual(schema.properties.evidence.items.properties.source_reference.enum, ['website_home', 'website_page_2', 'user_notes']);
    assert.deepEqual(schema.properties.best_landing_pages.items.properties.source_reference.enum, ['website_home', 'website_page_2']);
    assert.deepEqual(schema.properties.weak_pages.items.properties.source_reference.enum, ['website_home', 'website_page_2']);
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

test('analysis rejects invented landing-page provenance before canonical persistence', async (t) => {
  t.after(mockWebsiteRequest());
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.VITE_SUPABASE_URL;
  const originalKey = process.env.VITE_SUPABASE_ANON_KEY;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  let finalizeCalls = 0;
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const invented = richAnalysis({
    best_landing_pages: [{ source_reference: 'website_page_99', reason: 'Invented page' }],
    evidence: [{ source_type: 'website', source_reference: 'website_home', finding: 'Home evidence', confidence: 0.8 }],
  });

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return jsonResponse({ id: 'provenance-user' });
    if (target.includes('/rest/v1/pods?')) return jsonResponse([{ id: 'provenance-pod', pod_name: 'Provenance', brand_name: 'Brand', pod_type: 'website', source_type: 'website', source_url: 'https://1.0.0.1', source_locked_at: null }]);
    if (target === 'https://1.0.0.1/' || target === 'https://1.0.0.1') return new Response('<h1>Public home</h1>', { headers: { 'content-type': 'text/html' } });
    if (target === 'https://api.openai.com/v1/responses') return jsonResponse({ status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(invented) }] }] });
    if (target.includes('/rest/v1/rpc/finalize_pod_analysis')) { finalizeCalls += 1; return jsonResponse('never'); }
    throw new Error(`Unexpected network call: ${target}`);
  };

  const result = {};
  const response = { setHeader() {}, status(value) { result.status = value; return response; }, json(value) { result.body = value; return value; } };
  try {
    await analyzeHandler({ method: 'POST', headers: { authorization: 'Bearer user-token', 'x-forwarded-for': '198.51.100.49' }, body: { podId: 'provenance-pod' } }, response);
    assert.equal(result.status, 500);
    assert.match(result.body.error, /unknown source/i);
    assert.equal(finalizeCalls, 0);
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

test('user notes cannot replace the required image evidence for a photos-only pod', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.VITE_SUPABASE_URL;
  const originalKey = process.env.VITE_SUPABASE_ANON_KEY;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  let providerCalls = 0;
  process.env.VITE_SUPABASE_URL = 'https://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return jsonResponse({ id: 'notes-only-user' });
    if (target.includes('/rest/v1/pods?')) return jsonResponse([{ id: 'notes-only-pod', pod_name: 'Notes only', pod_type: 'images', source_type: 'photos', source_url: null, source_locked_at: null }]);
    if (target === 'https://api.openai.com/v1/responses') { providerCalls += 1; throw new Error('provider must not be called'); }
    throw new Error(`Unexpected network call: ${target}`);
  };
  const result = {};
  const response = { setHeader() {}, status(value) { result.status = value; return response; }, json(value) { result.body = value; return value; } };
  try {
    await analyzeHandler({ method: 'POST', headers: { authorization: 'Bearer user-token', 'x-forwarded-for': '198.51.100.50' }, body: { podId: 'notes-only-pod', notes: 'Owner context without a photo', imageUrls: [] } }, response);
    assert.equal(result.status, 422);
    assert.match(result.body.error, /primary source URL or at least one brand photo/i);
    assert.equal(providerCalls, 0);
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
