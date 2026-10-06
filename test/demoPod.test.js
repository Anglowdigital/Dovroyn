import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canMutatePod, DEMO_WORKSPACE } from '../src/lib/demoPod.js';
import * as demoPod from '../src/lib/demoPod.js';
import publicChatHandler from '../api/ai/chat.js';

test('public demo is a complete fictional read-only showcase', () => {
  const sourceHost = new URL(DEMO_WORKSPACE.pod.source_url).hostname;

  assert.equal(DEMO_WORKSPACE.readOnly, true);
  assert.equal(sourceHost.endsWith('.example'), true);
  assert.equal(DEMO_WORKSPACE.pod.status, 'direction_locked');
  assert.ok(DEMO_WORKSPACE.pod.source_locked_at);
  assert.ok(DEMO_WORKSPACE.sources.length >= 1);
  assert.ok(DEMO_WORKSPACE.analysis.evidence.length >= 2);
  assert.ok(DEMO_WORKSPACE.analysis.platforms.length >= 4);
  assert.ok(DEMO_WORKSPACE.messages.length >= 3);
  assert.ok(DEMO_WORKSPACE.posts.length >= 4);
  assert.equal(DEMO_WORKSPACE.directionApproved, true);
  assert.equal(DEMO_WORKSPACE.calendarCreated, true);
  assert.equal(DEMO_WORKSPACE.campaignState, 'Approved');
  assert.equal(DEMO_WORKSPACE.posts.every((post) => post.characterCount === post.content.length), true);

  const assetRoles = new Set(DEMO_WORKSPACE.assets.map((asset) => asset.assetRole));
  assert.deepEqual(assetRoles, new Set(['logo', 'brand_photo', 'campaign_asset']));
});

test('showcase source contains navigation only and no live pod controls or services', () => {
  const source = readFileSync(new URL('../src/pages/PodWorkspace.jsx', import.meta.url), 'utf8');
  const showcase = source.split('function DemoPodShowcase() {')[1]?.split('export default function PodWorkspace')[0] || '';

  assert.ok(showcase.length > 0);
  assert.equal((showcase.match(/case '[^']+'/g) || []).length, 15);
  assert.equal((showcase.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(showcase, /<(?:form|input|textarea|select)\b/i);
  assert.doesNotMatch(showcase, /(?:supabase|Repository|requestPod|askPod|uploadPod|savePod|approvePod|updateSocial|fetch\s*\()/);
});

test('competitor and learning showcase panels cannot be empty or imply continuous real monitoring', () => {
  assert.ok(DEMO_WORKSPACE.competitors?.length >= 2, 'missing fictional competitors');
  assert.ok(DEMO_WORKSPACE.learningHistory?.length >= 3, 'missing fictional learning history');
  for (const competitor of DEMO_WORKSPACE.competitors) {
    assert.equal(new URL(competitor.sourceUrl).hostname.endsWith('.example'), true);
    assert.ok(competitor.observation.length > 20);
    assert.ok(competitor.sourceReference.length > 0);
  }
  for (const entry of DEMO_WORKSPACE.learningHistory) {
    assert.ok(entry.title && entry.detail && entry.at);
  }
});

test('demo tabs support wrapping arrows and Home/End without triggering actions', () => {
  assert.equal(typeof demoPod.getNextDemoTab, 'function', 'keyboard navigation is absent');
  assert.equal(demoPod.DEMO_TAB_IDS.length, 15);
  assert.equal(demoPod.getNextDemoTab('sources', 'ArrowDown'), 'direction');
  assert.equal(demoPod.getNextDemoTab('sources', 'ArrowUp'), 'learning');
  assert.equal(demoPod.getNextDemoTab('learning', 'ArrowRight'), 'sources');
  assert.equal(demoPod.getNextDemoTab('direction', 'ArrowLeft'), 'sources');
  assert.equal(demoPod.getNextDemoTab('sources', 'End'), 'learning');
  assert.equal(demoPod.getNextDemoTab('learning', 'Home'), 'sources');
  assert.equal(demoPod.getNextDemoTab('sources', 'Enter'), null);
});

test('demo cannot regress to inaccessible toggles or add a second page H1', () => {
  const source = readFileSync(new URL('../src/pages/PodWorkspace.jsx', import.meta.url), 'utf8');
  const showcase = source.split('function DemoPodShowcase() {')[1].split('export default function PodWorkspace')[0];
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const demoPage = app.split('function DemoPodPage()')[1].split('function AuthPage(')[0];
  for (const role of ['tablist', 'tab', 'tabpanel']) assert.ok(showcase.includes('role="' + role + '"'));
  assert.match(showcase, /aria-selected={activeTab === key}/);
  assert.match(showcase, /aria-controls="demo-panel"/);
  assert.match(showcase, /role="tabpanel" id="demo-panel"/);
  assert.match(showcase, /aria-labelledby={`demo-tab-\$\{activeTab\}`}/);
  assert.match(showcase, /onKeyDown=/);
  assert.match(showcase, /\.focus\(\)/);
  assert.doesNotMatch(showcase, /<h1\b|aria-pressed|<main\b/);
  assert.match(showcase, /<h2>{pod.pod_name}<\/h2>/);
  assert.equal((demoPage.match(/<h1\b/g) || []).length, 1);
  assert.match(source, /if \(!canMutatePod\(demo\)\) return <DemoPodShowcase \/>;/);
});

test('demo mutations are blocked without disabling real signed-in pods', () => {
  assert.equal(canMutatePod(true), false);
  assert.equal(canMutatePod(false), true);
});

test('crafted demo chat requests are rejected before reaching OpenAI', async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('The provider must not be called for a read-only showcase.');
  };

  const result = { status: null, body: null, headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(value) { result.status = value; return response; },
    json(value) { result.body = value; return value; },
  };

  try {
    await publicChatHandler({
      method: 'POST',
      headers: {},
      body: { question: 'Run the demo pod for me', demoPod: true },
      socket: { remoteAddress: '203.0.113.10' },
    }, response);

    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'SIGN_UP_REQUIRED');
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
