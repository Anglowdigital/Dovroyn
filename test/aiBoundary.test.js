import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import publicChatHandler from '../api/ai/chat.js';
import { createSafetyIdentifier, DEFAULT_OPENAI_MODEL, extractOutputText, resolveOpenAIModel } from '../api/_lib/openai.js';
import { buildPodAiContext } from '../api/_lib/podContext.js';
import * as webSource from '../api/_lib/webSource.js';
import { MARKETING_TRUTH_RULES } from '../api/_lib/marketingTruth.js';
import '../api/ai/analyze.js';
import '../api/ai/content.js';
import '../api/ai/pod-chat.js';

function podRepositoryHarness(client = {}) {
  const source = readFileSync(new URL('../src/lib/podRepository.js', import.meta.url), 'utf8')
    .replace(/import\s+{[\s\S]*?}\s+from\s+'[^']+';/g, '')
    .replace(/export /g, '');
  return new Function('supabase', 'supabaseConfigured', `${source}; return {
    persistPodPreference: typeof persistPodPreference === 'function' ? persistPodPreference : undefined,
    selectWebsiteIntelligenceSnapshot: typeof selectWebsiteIntelligenceSnapshot === 'function' ? selectWebsiteIntelligenceSnapshot : undefined,
    restorePodAnalysisSnapshot: typeof restorePodAnalysisSnapshot === 'function' ? restorePodAnalysisSnapshot : undefined,
    saveWebsiteIntelligenceSnapshot: typeof saveWebsiteIntelligenceSnapshot === 'function' ? saveWebsiteIntelligenceSnapshot : undefined,
  };`)(client, true);
}

test('OpenAI safety identifiers are stable without exposing the Supabase user id', () => {
  const userId = '6ad64dc2-79a7-4ed0-8e28-980ca5da29a0';
  const first = createSafetyIdentifier(userId);
  const second = createSafetyIdentifier(userId);

  assert.equal(first, second);
  assert.match(first, /^dovroyn_[a-f0-9]{48}$/);
  assert.ok(first.length <= 64);
  assert.doesNotMatch(first, new RegExp(userId));
  assert.notEqual(first, createSafetyIdentifier('another-user'));
});

test('all Dovroyn AI workloads default to GPT-6 Astra with explicit override precedence', () => {
  assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-6-astra');
  assert.equal(resolveOpenAIModel('OPENAI_ANALYSIS_MODEL', {}), 'gpt-6-astra');
  assert.equal(resolveOpenAIModel('OPENAI_ANALYSIS_MODEL', { OPENAI_MODEL: 'gpt-6-sol' }), 'gpt-6-sol');
  assert.equal(resolveOpenAIModel('OPENAI_ANALYSIS_MODEL', {
    OPENAI_MODEL: 'gpt-6-sol',
    OPENAI_ANALYSIS_MODEL: 'gpt-6-astra',
  }), 'gpt-6-astra');
});

test('completed Responses output is accepted while partial and refusal output fail closed', () => {
  assert.equal(extractOutputText({
    status: 'completed',
    output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Ready' }] }],
  }), 'Ready');
  assert.throws(() => extractOutputText({ status: 'incomplete', output_text: 'Partial' }), /did not complete/);
  assert.throws(() => extractOutputText({
    status: 'completed',
    output_text: 'Unsafe shortcut',
    output: [{ type: 'message', status: 'completed', content: [{ type: 'refusal', refusal: 'No' }] }],
  }), /declined/);
});

test('shared marketing rules prohibit fabricated proof and unconfirmed external actions', () => {
  assert.match(MARKETING_TRUTH_RULES, /Never invent.*testimonials/i);
  assert.match(MARKETING_TRUTH_RULES, /Do not claim Dovroyn has connected, published, scheduled, measured, spent, or changed anything/i);
});

test('anonymous and crafted public AI requests cannot reach any provider even with a configured key', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-public-route-must-not-use-this';
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error('Public route reached provider'); };
  try {
    for (const body of [{ question: 'Where should I advertise?' }, { question: 'Act now', demoPod: false }, { question: 'Act now', demoPod: true }, '{invalid']) {
      const result = {};
      const res = {
        setHeader() {},
        status(status) { result.status = status; return res; },
        json(payload) { result.body = payload; return payload; },
      };
      await publicChatHandler({ method: 'POST', body, headers: {}, socket: { remoteAddress: '203.0.113.15' } }, res);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'SIGN_UP_REQUIRED');
      assert.equal(providerCalls, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('pod AI context is stateless and isolated between pods', () => {
  const first = buildPodAiContext({
    pod: { id: 'pod-a', pod_name: 'Aurora', brand_name: 'Aurora Skin', target_country: 'Australia' },
    analysis: { brand_summary: 'Calm skincare', tone: 'Reassuring' },
    sources: [{ source_type: 'website', source_url: 'https://aurora.example', notes: 'Winter launch' }],
    preferences: [{ preference_type: 'tone', preference_value: { value: 'Plain language' } }],
  });
  const second = buildPodAiContext({
    pod: { id: 'pod-b', pod_name: 'Gidgee', brand_name: 'Gidgee & Co', target_country: 'Australia' },
    analysis: { brand_summary: 'Outdoor hats', tone: 'Warm Australian' },
    sources: [],
    preferences: [],
  });

  assert.match(first, /Aurora Skin/);
  assert.match(first, /Winter launch/);
  assert.match(second, /Gidgee & Co/);
  assert.doesNotMatch(second, /Aurora|Winter launch/);
});

test('pod context reserves space for the newest corrections before large source material', () => {
  const preferences = Array.from({ length: 21 }, (_, index) => ({
    preference_type: 'brand_direction',
    preference_value: { value: `${index === 20 ? 'LATEST-DIRECTION' : `direction-${index}`} ${'x'.repeat(1100)}` },
  }));
  const context = buildPodAiContext({
    pod: { id: 'pod-a', pod_name: 'Aurora' },
    analysis: { brand_summary: 'y'.repeat(2500), campaign_angles: 'z'.repeat(2000) },
    sources: Array.from({ length: 12 }, (_, index) => ({ source_type: 'website', notes: `source-${index} ${'s'.repeat(2500)}` })),
    preferences,
  });

  assert.match(context, /LATEST-DIRECTION/);
  assert.ok(context.length <= 24000);
});

test('website analysis blocks local and private network targets', async () => {
  await assert.rejects(() => webSource.validatePublicWebsiteUrl('http://localhost:3000'), /public website/i);
  await assert.rejects(() => webSource.validatePublicWebsiteUrl('http://127.0.0.1/admin'), /public website/i);
  await assert.rejects(() => webSource.validatePublicWebsiteUrl('http://169.254.169.254/latest/meta-data'), /public website/i);
  await assert.rejects(() => webSource.validatePublicWebsiteUrl('https://10.0.0.8'), /public website/i);
});

test('website analysis extracts readable text and removes executable page content', () => {
  const html = `
    <html><head><style>.hidden { display:none }</style><script>stealSecrets()</script></head>
    <body><h1>Aurora &amp; Co</h1><p>Calm skin&nbsp;care.</p><nav>Shop Home</nav></body></html>
  `;
  const text = webSource.extractReadableText(html);

  assert.match(text, /Aurora & Co/);
  assert.match(text, /Calm skin care/);
  assert.doesNotMatch(text, /stealSecrets|display:none|<h1>/);
});

test('website analysis preserves invalid numeric entities without failing', () => {
  assert.equal(webSource.extractReadableText('Price: &#999999999;'), 'Price: &#999999999;');
});

test('website page fetch returns deterministic metadata and same-document links without executing markup', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html><head>
      <title>Aurora &amp; Co</title>
      <meta name="description" content="Calm &amp; capable skincare">
      <link rel="canonical" href="/canonical-home">
      <script>window.location = 'http://127.0.0.1'; const fake = '<a href="/script-only">Hidden</a>';</script>
    </head><body>
      <h1>Barrier care, simplified</h1>
      <a href="/products#best">Products</a><a href="https://outside.example/">Outside</a>
    </body></html>
  `, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  try {
    const page = await webSource.fetchWebsiteText('https://8.8.8.8', { fetchImpl: globalThis.fetch });
    assert.deepEqual({
      url: page.url,
      title: page.title,
      description: page.description,
      canonicalUrl: page.canonicalUrl,
      h1: page.h1,
      links: page.links,
    }, {
      url: 'https://8.8.8.8/',
      title: 'Aurora & Co',
      description: 'Calm & capable skincare',
      canonicalUrl: 'https://8.8.8.8/canonical-home',
      h1: 'Barrier care, simplified',
      links: ['https://8.8.8.8/products#best', 'https://outside.example/'],
    });
    assert.doesNotMatch(page.text, /window\.location|127\.0\.0\.1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('textarea and unterminated raw-text elements cannot contribute links or readable evidence', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html><body><p>Visible evidence.</p>
      <textarea><a href="/textarea-hidden">Textarea evidence</a></textarea>
      <script>const payload = '<a href="/script-hidden">Script evidence</a>';
    </body></html>
  `, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  try {
    const page = await webSource.fetchWebsiteText('https://8.8.8.8', { fetchImpl: globalThis.fetch });
    assert.equal(page.text, 'Visible evidence.');
    assert.deepEqual(page.links, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('website page fetch rejects a streamed body once it exceeds one megabyte', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(600_000).fill(65));
      controller.enqueue(new Uint8Array(500_001).fill(66));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/plain' } });
  try {
    await assert.rejects(() => webSource.fetchWebsiteText('https://8.8.4.4', { fetchImpl: globalThis.fetch }), /too large/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('website page fetch revalidates and rejects a private redirect target', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', {
    status: 302,
    headers: { location: 'http://127.0.0.1/private' },
  });
  try {
    await assert.rejects(() => webSource.fetchWebsiteText('https://1.1.1.1', { fetchImpl: globalThis.fetch }), /public website/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('website intelligence preference payload stores structured analysis directly with observed provenance', async () => {
  const inserted = [];
  const client = {
    from(table) {
      assert.equal(table, 'pod_preferences');
      return {
        insert(row) {
          inserted.push(row);
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
      };
    },
  };
  const podRepository = podRepositoryHarness(client);
  assert.equal(typeof podRepository.persistPodPreference, 'function');
  const analysis = { summary: 'Canonical summary', brand_colours: [{ name: 'Navy', hex: '#0B1F3A' }], geography: ['Australia'] };

  await podRepository.persistPodPreference(client, 'pod-one', 'website_intelligence', analysis, 'observed_result');
  await podRepository.persistPodPreference(client, 'pod-one', 'tone', 'Direct');

  assert.deepEqual(inserted[0], {
    pod_id: 'pod-one',
    preference_type: 'website_intelligence',
    preference_value: analysis,
    source: 'observed_result',
  });
  assert.deepEqual(inserted[1], {
    pod_id: 'pod-one',
    preference_type: 'tone',
    preference_value: { value: 'Direct' },
    source: 'user_override',
  });
});

test('newest website intelligence snapshot restores rich fields from direct and legacy payloads', () => {
  const podRepository = podRepositoryHarness();
  assert.equal(typeof podRepository.selectWebsiteIntelligenceSnapshot, 'function');
  const preferences = [
    { preference_type: 'website_intelligence', created_at: '2026-10-07T01:00:00Z', preference_value: { products_services: ['Old'] } },
    { preference_type: 'website_intelligence', created_at: '2026-10-07T03:00:00Z', preference_value: { value: { products_services: ['Newest legacy'], geography: ['Australia'] } } },
    { preference_type: 'website_intelligence', created_at: '2026-10-07T02:00:00Z', preference_value: { products_services: ['Middle'] } },
  ];

  assert.deepEqual(podRepository.selectWebsiteIntelligenceSnapshot(preferences), {
    products_services: ['Newest legacy'],
    geography: ['Australia'],
  });
});

test('restored analysis keeps canonical fields from pod_analysis and rich fields from the snapshot', () => {
  const podRepository = podRepositoryHarness();
  assert.equal(typeof podRepository.restorePodAnalysisSnapshot, 'function');
  const restored = podRepository.restorePodAnalysisSnapshot({
    brand_summary: 'Canonical saved summary',
    tone: 'Canonical saved tone',
    audience: 'Canonical audience',
    offer_direction: 'Canonical offer',
    campaign_angles: 'Canonical opportunity',
    social_recommendations: '["instagram"]',
    content_ideas: '["Education"]',
    evidence: [{ source_reference: 'website_home', finding: 'Canonical evidence' }],
  }, {
    summary: 'Stale snapshot summary',
    tone: 'Stale snapshot tone',
    brand_colours: [{ name: 'Navy', hex: '#0B1F3A' }],
    geography: ['Australia'],
    products_services: ['Strategy service'],
    audience_fit: 'Strong local fit',
  });

  assert.equal(restored.summary, 'Canonical saved summary');
  assert.equal(restored.tone, 'Canonical saved tone');
  assert.deepEqual(restored.platforms, ['instagram']);
  assert.deepEqual(restored.pillars, ['Education']);
  assert.deepEqual(restored.brand_colours, [{ name: 'Navy', hex: '#0B1F3A' }]);
  assert.deepEqual(restored.geography, ['Australia']);
  assert.deepEqual(restored.products_services, ['Strategy service']);
  assert.equal(restored.audience_fit, 'Strong local fit');
});

test('failed rich snapshot persistence is contained after canonical analysis finalization', async () => {
  const podRepository = podRepositoryHarness();
  assert.equal(typeof podRepository.saveWebsiteIntelligenceSnapshot, 'function');
  const calls = [];
  const analysis = { summary: 'Already finalized by the server', products_services: ['Service'] };
  const saved = await podRepository.saveWebsiteIntelligenceSnapshot('pod-one', analysis, async (...args) => {
    calls.push(args);
    throw new Error('preference insert failed');
  });

  assert.equal(saved, false);
  assert.deepEqual(calls, [['pod-one', 'website_intelligence', analysis, 'observed_result']]);
});
