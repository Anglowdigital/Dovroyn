import test from 'node:test';
import assert from 'node:assert/strict';
import publicChatHandler from '../api/ai/chat.js';
import { createSafetyIdentifier, DEFAULT_OPENAI_MODEL, extractOutputText, resolveOpenAIModel } from '../api/_lib/openai.js';
import { buildPodAiContext } from '../api/_lib/podContext.js';
import { extractReadableText, validatePublicWebsiteUrl } from '../api/_lib/webSource.js';
import { MARKETING_TRUTH_RULES } from '../api/_lib/marketingTruth.js';
import '../api/ai/analyze.js';
import '../api/ai/content.js';
import '../api/ai/pod-chat.js';

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
  await assert.rejects(() => validatePublicWebsiteUrl('http://localhost:3000'), /public website/i);
  await assert.rejects(() => validatePublicWebsiteUrl('http://127.0.0.1/admin'), /public website/i);
  await assert.rejects(() => validatePublicWebsiteUrl('http://169.254.169.254/latest/meta-data'), /public website/i);
  await assert.rejects(() => validatePublicWebsiteUrl('https://10.0.0.8'), /public website/i);
});

test('website analysis extracts readable text and removes executable page content', () => {
  const html = `
    <html><head><style>.hidden { display:none }</style><script>stealSecrets()</script></head>
    <body><h1>Aurora &amp; Co</h1><p>Calm skin&nbsp;care.</p><nav>Shop Home</nav></body></html>
  `;
  const text = extractReadableText(html);

  assert.match(text, /Aurora & Co/);
  assert.match(text, /Calm skin care/);
  assert.doesNotMatch(text, /stealSecrets|display:none|<h1>/);
});

test('website analysis preserves invalid numeric entities without failing', () => {
  assert.equal(extractReadableText('Price: &#999999999;'), 'Price: &#999999999;');
});
