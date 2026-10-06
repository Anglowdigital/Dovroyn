import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../api/_lib/supabaseAuth.js';
import { buildPodAiContext } from '../api/_lib/podContext.js';
import { requestCompetitorSnapshot } from '../src/lib/aiClient.js';

const route = await import('../api/ai/competitors.js').catch(() => ({}));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
let identity = 0;
function snapshot(urls = ['https://8.8.8.8/']) {
  return {
    summary: 'Public pages focus on product education.',
    competitors: urls.map((url) => ({ url, positioning: 'Product education', public_strengths: ['Clear materials'], public_gaps: ['Limited care guidance'] })),
    opportunities: ['Explain care using approved product information.'],
    evidence: urls.map((_, index) => ({ source_reference: `competitor_${index + 1}_website_home`, finding: 'The page describes materials.' })),
    confidence: 0.8, checked_at: '1900-01-01T00:00:00Z',
  };
}
async function exercise(options = {}) {
  assert.equal(typeof route.default, 'function', 'authenticated competitor handler is missing');
  const originalFetch = globalThis.fetch;
  const variables = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'OPENAI_API_KEY', 'OPENAI_ANALYSIS_MODEL'];
  const originalEnv = variables.map((key) => process.env[key]);
  Object.assign(process.env, { VITE_SUPABASE_URL: 'https://supabase.test', VITE_SUPABASE_ANON_KEY: 'public-test-key', OPENAI_API_KEY: 'test-only', OPENAI_ANALYSIS_MODEL: 'analysis-test-model' });
  const calls = [];
  const result = {};
  const response = { setHeader() {}, status(status) { result.status = status; return this; }, json(body) { result.body = body; return body; } };
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ target, ...init });
    if (target.includes('/auth/v1/user')) return json(options.invalidAuth ? {} : { id: 'owner' }, options.invalidAuth ? 401 : 200);
    if (target.includes('/rest/v1/pods?')) return json(options.wrongOwner ? [] : [{ id: 'one', pod_name: 'Own pod', brand_name: 'Own brand' }]);
    if (target.includes('/rest/v1/pod_preferences') && init.method === 'POST') {
      if (options.saveFailure) return json({ message: 'save denied' }, 403);
      if (options.emptySave) return json([]);
      return json([{ id: 'saved', created_at: '2026-10-07T00:00:00Z', ...JSON.parse(init.body), ...(options.wrongSave ? { pod_id: 'two' } : {}) }]);
    }
    if (target === 'https://api.openai.com/v1/responses') {
      if (options.providerFailure) return json({ error: { message: 'provider failed' } }, 502);
      return json({ status: options.incomplete ? 'incomplete' : 'completed', output_text: JSON.stringify(options.model || snapshot()) });
    }
    if (/^https:\/\/(8\.8\.8\.8|1\.1\.1\.1)/.test(target)) {
      if (options.crawlFailure) return new Response('unreadable', { status: 404 });
      return new Response(`<h1>Products</h1><p>${'Readable materials. '.repeat(options.large ? 1200 : 1)}</p><a href='/products'>Products</a><a href='/about'>About</a>`, { headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`Unexpected external request ${target}`);
  };
  try {
    await route.default({ method: options.method || 'POST', headers: { ...(options.noAuth ? {} : { authorization: 'Bearer own-token' }), 'x-forwarded-for': options.ip || `test-competitors-${++identity}` }, body: options.body ?? { podId: 'one', urls: ['https://8.8.8.8'] } }, response);
    return { ...result, calls, provider: calls.filter((call) => call.target.includes('api.openai.com')), saves: calls.filter((call) => call.method === 'POST' && call.target.includes('/pod_preferences')) };
  } finally {
    globalThis.fetch = originalFetch;
    variables.forEach((key, index) => originalEnv[index] === undefined ? delete process.env[key] : process.env[key] = originalEnv[index]);
  }
}

test('method and auth reject before body parsing or external providers', async () => {
  for (const options of [{ method: 'GET', body: '{' }, { noAuth: true, body: '{' }, { invalidAuth: true, body: '{' }]) {
    const result = await exercise(options);
    assert.equal(result.status, options.method ? 405 : 401);
    assert.equal(result.provider.length, 0);
    assert.equal(result.saves.length, 0);
  }
});

test('wrong owner and malformed body cannot crawl or call OpenAI', async () => {
  for (const options of [{ wrongOwner: true }, { body: '{' }, { body: { urls: ['https://8.8.8.8'] } }]) {
    const result = await exercise(options);
    assert.equal(result.status, options.wrongOwner ? 404 : 400);
    assert.equal(result.provider.length, 0);
    assert.equal(result.calls.some((call) => call.target.startsWith('https://8.8.8.8')), false);
  }
});

test('URL cap, duplicates, unsafe networks, ports and credentials fail before provider calls', async () => {
  const rejected = [[], ['https://8.8.8.8', 'https://1.1.1.1', 'https://8.8.4.4', 'https://9.9.9.9'], ['https://8.8.8.8', 'https://8.8.8.8/'], ['https://127.0.0.1'], ['https://8.8.8.8:444'], ['https://owner:password@8.8.8.8'], ['file:///etc/passwd'], ['bad'], ['https://8.8.8.8/' + 'a'.repeat(1000)], ['https://8.8.8.8', 'https://10.0.0.1']];
  for (const urls of rejected) {
    const result = await exercise({ body: { podId: 'one', urls } });
    assert.equal(result.status, 400, String(urls));
    assert.equal(result.provider.length, 0);
    assert.equal(result.saves.length, 0);
    assert.equal(result.calls.some((call) => call.target.startsWith('https://8.8.8.8')), false);
  }
});

test('IP rate limit blocks fourth request before crawling or provider use', async () => {
  const ip = `limit-${++identity}`;
  for (let index = 0; index < 3; index++) assert.equal((await exercise({ ip })).status, 200);
  const rejected = await exercise({ ip });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.provider.length, 0);
  assert.equal(rejected.saves.length, 0);
});

test('bounded comparison labels each competitor uniquely and confirms bearer-scoped persistence before success', async () => {
  const urls = ['https://8.8.8.8/', 'https://1.1.1.1/'];
  const started = Date.now();
  const result = await exercise({ large: true, body: { podId: 'one', urls }, model: snapshot(urls) });
  assert.equal(result.status, 200);
  assert.equal(result.body.saved, true);
  assert.equal(result.body.ok, true);
  assert.ok(Date.parse(result.body.snapshot.checked_at) >= started);
  assert.equal(result.provider.length, 1);
  const request = JSON.parse(result.provider[0].body);
  assert.equal(request.model, 'analysis-test-model');
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.required, ['summary', 'competitors', 'opportunities', 'evidence', 'confidence', 'checked_at']);
  const labels = request.text.format.schema.properties.evidence.items.properties.source_reference.enum;
  assert.equal(labels.length, new Set(labels).size);
  assert.ok(labels.every((label) => /^competitor_[12]_website_/.test(label)));
  const supplied = request.input[0].content[0].text;
  assert.ok(supplied.length < 25000);
  assert.ok(result.calls.filter((call) => /^https:\/\/(8\.8\.8\.8|1\.1\.1\.1)/.test(call.target)).length <= 4);
  assert.equal(result.saves.length, 1);
  const saved = JSON.parse(result.saves[0].body);
  assert.equal(saved.pod_id, 'one');
  assert.equal(saved.preference_type, 'competitor_snapshot');
  assert.equal(saved.source, 'observed_result');
  assert.equal(saved.active, true);
  assert.deepEqual(saved.preference_value, result.body.snapshot);
  assert.equal(result.saves[0].headers.Authorization, 'Bearer own-token');
  assert.equal(result.saves[0].headers.Prefer, 'return=representation');
  assert.equal(result.calls.some((call) => /ad_analysis|agent_audit_events/.test(call.target)), false);
  assert.ok(result.calls.indexOf(result.saves[0]) > result.calls.indexOf(result.provider[0]));
  for (const prohibition of ['traffic', 'conversions', 'ad spend', 'sales', 'market share', 'private activity', 'continuous monitoring', 'outperforming', 'testimonials']) assert.ok(request.instructions.includes(prohibition), prohibition);
});

test('model URL/evidence mismatch, incomplete responses and performance claims never save', async () => {
  const invalid = [snapshot(['https://1.1.1.1/']), { ...snapshot(), competitors: [] }, { ...snapshot(), competitors: [...snapshot().competitors, ...snapshot().competitors] }, { ...snapshot(), evidence: [{ source_reference: 'website_home', finding: 'Invented label' }] }, { ...snapshot(), evidence: [] }, { ...snapshot(), summary: 'This brand is outperforming competitors in sales.' }, { ...snapshot(), summary: 'Traffic grew by 50%.' }];
  for (const model of invalid) {
    const result = await exercise({ model });
    assert.ok(result.status >= 400);
    assert.equal(result.saves.length, 0);
    assert.notEqual(result.body.saved, true);
  }
  for (const options of [{ incomplete: true }, { providerFailure: true }, { crawlFailure: true }]) {
    const result = await exercise(options);
    assert.ok(result.status >= 400);
    assert.equal(result.saves.length, 0);
  }
});

test('denied, empty or wrong-Pod save results fail closed', async () => {
  for (const options of [{ saveFailure: true }, { emptySave: true }, { wrongSave: true }]) {
    const result = await exercise(options);
    assert.ok(result.status >= 400);
    assert.notEqual(result.body.saved, true);
    assert.notEqual(result.body.ok, true);
  }
});

test('ambiguous URL spellings cannot be silently repaired into accepted public URLs', async () => {
  for (const url of ['https:/8.8.8.8', 'https:8.8.8.8', 'https://8.8.8.8\\private']) {
    const result = await exercise({ body: { podId: 'one', urls: [url] } });
    assert.equal(result.status, 400, url);
    assert.equal(result.provider.length, 0);
    assert.equal(result.saves.length, 0);
  }
});

test('latest user direction is fetched separately and survives many newer observed snapshots within 24k context', async () => {
  const original = globalThis.fetch;
  const previous = [process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY];
  process.env.VITE_SUPABASE_URL = 'https://supabase.test'; process.env.VITE_SUPABASE_ANON_KEY = 'public-key';
  const queries = [];
  const direction = { preference_type: 'brand_direction', preference_value: { value: 'LATEST-USER-DIRECTION' }, active: true, created_at: '2026-01-01' };
  globalThis.fetch = async (url) => {
    queries.push(String(url));
    if (String(url).includes('preference_type=eq.brand_direction')) return json([direction]);
    if (String(url).includes('/pod_preferences?')) return json(Array.from({ length: 20 }, (_, index) => ({ preference_type: 'competitor_snapshot', preference_value: { summary: 'Observed '.repeat(4000) }, created_at: `2026-10-${String(index + 1).padStart(2, '0')}` })));
    return json([]);
  };
  try {
    const loaded = await auth.loadPodAiContext('own-token', 'one');
    assert.ok(queries.some((query) => query.includes('preference_type=eq.brand_direction') && query.includes('limit=1')));
    const context = buildPodAiContext({ pod: { id: 'one' }, ...loaded });
    assert.match(context, /LATEST-USER-DIRECTION/);
    assert.match(context, /competitor_snapshot/);
    assert.ok(context.length <= 24000);
  } finally { globalThis.fetch = original; ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]); }
});

test('client submits only Pod URLs with bearer auth and refuses unconfirmed saves and provider errors', async () => {
  const original = globalThis.fetch;
  let payload = { ok: true, saved: true, snapshot: snapshot() };
  let status = 200;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, ...init }); return json(payload, status); };
  try {
    const arguments_ = { accessToken: 'own-token', podId: 'one', urls: ['https://8.8.8.8'] };
    assert.deepEqual(await requestCompetitorSnapshot(arguments_), payload);
    assert.equal(calls[0].url, '/api/ai/competitors');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.Authorization, 'Bearer own-token');
    assert.deepEqual(JSON.parse(calls[0].body), { podId: 'one', urls: ['https://8.8.8.8'] });
    payload = { ok: true, saved: false, snapshot: snapshot() };
    await assert.rejects(requestCompetitorSnapshot(arguments_), /not confirmed/);
    payload = { error: 'save denied' }; status = 403;
    await assert.rejects(requestCompetitorSnapshot(arguments_), /save denied/);
  } finally { globalThis.fetch = original; }
});
