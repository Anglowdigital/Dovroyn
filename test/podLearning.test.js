import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { createClient } from '@supabase/supabase-js';
import * as direction from '../src/lib/podDirection.js';
import * as state from '../src/lib/podState.js';
import * as platforms from '../src/lib/platforms.js';
import * as setup from '../src/lib/podSetup.js';
import * as demo from '../src/lib/demoPod.js';
import { getPlan } from '../src/lib/plans.js';
const learning = await import('../src/lib/podLearning.js').catch(() => ({}));

const workspace = (extra = {}) => ({ pod: { id: 'one', pod_name: 'Own Pod', target_country: 'Australia' }, preferences: [], campaigns: [], calendarItems: [], posts: [], budgets: [], sources: [], assets: [], messages: [], analysis: { brand_summary: 'Own brand', social_recommendations: '[]', content_ideas: '[]' }, ...extra });

const savedSnapshot = (extra = {}) => ({
  summary: 'Saved public comparison',
  competitors: [{ url: 'https://8.8.8.8/', positioning: 'Saved positioning', public_strengths: ['Materials'], public_gaps: ['Care'] }],
  opportunities: ['Explain care'],
  evidence: [{ source_reference: 'competitor_1_website_home', finding: 'Material detail' }],
  confidence: 0.8, checked_at: '2026-10-07T00:00:00.000Z', ...extra,
});

test('learning derives sorted Pod-scoped saved activity from every supported collection, not fabricated audit events', () => {
  assert.equal(typeof learning.normalizePodLearning, 'function', 'learning normalizer is missing');
  const rows = workspace({ pod: { id: 'one', direction_approved_at: '2026-10-09' },
    preferences: [
      { id: 'direction', pod_id: 'one', preference_type: 'brand_direction', preference_value: { value: 'Warm language' }, created_at: '2026-10-01', source: 'user_override' },
      { id: 'platform', pod_id: 'one', preference_type: 'platform_selection', preference_value: { platforms: ['email'] }, created_at: '2026-10-02' },
      { id: 'website', pod_id: 'one', preference_type: 'website_intelligence', preference_value: { summary: 'Our website' }, created_at: '2026-10-03' },
      { id: 'budget-decision', pod_id: 'one', preference_type: 'budget_recommendation_decision', preference_value: { decision: 'approved', scope: 'plan_only' }, created_at: '2026-10-04' },
      { id: 'competitor', pod_id: 'one', preference_type: 'competitor_snapshot', preference_value: { value: savedSnapshot({ summary: 'Public comparison', checked_at: '2026-10-05' }) }, created_at: '2026-10-05', source: 'observed_result' },
      { id: 'foreign', pod_id: 'two', preference_type: 'brand_direction', preference_value: { value: 'DO-NOT-SHOW' }, created_at: '2026-10-10' },
    ],
    campaigns: [{ id: 'campaign', pod_id: 'one', name: 'Autumn', status: 'approved', created_at: '2026-10-01', updated_at: '2026-10-06' }],
    calendarItems: [{ id: 'calendar', pod_id: 'one', platform: 'email', caption: 'Draft schedule', scheduled_date: '2026-11-01', created_at: '2026-10-07' }],
    posts: [{ id: 'post', pod_id: 'one', platform: 'email', body: 'Edited caption', status: 'draft', created_at: '2026-10-01', updated_at: '2026-10-08' }],
    budgets: [{ id: 'budget', pod_id: 'one', planned_budget: '120.00', notes: 'Plan only', updated_at: '2026-10-08' }],
  });
  const events = learning.normalizePodLearning(rows);
  assert.equal(events.length, 10);
  assert.equal(events[0].type, 'direction_approval');
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.deepEqual(events.map((event) => event.occurredAt), [...events.map((event) => event.occurredAt)].sort().reverse());
  assert.ok(events.every((event) => event.id && event.title && event.detail && event.source));
  assert.doesNotMatch(JSON.stringify(events), /DO-NOT-SHOW|complete audit|immutable/i);
  assert.match(events.find((event) => event.type === 'budget').detail, /120/);
  assert.match(events.find((event) => event.type === 'campaign').detail, /approved/);
  assert.match(events.find((event) => event.type === 'social_post').detail, /Edited caption/);
  assert.equal(learning.normalizePodLearning(rows, { limit: 2 }).length, 2);
  assert.deepEqual(learning.normalizePodLearning(rows).map((event) => event.id), events.map((event) => event.id));
});

test('learning handles malformed collections and legacy values, strips HTML/control characters and bounds detail', () => {
  assert.equal(typeof learning.normalizePodLearning, 'function', 'learning normalizer is missing');
  assert.deepEqual(learning.normalizePodLearning(null), []);
  assert.deepEqual(learning.normalizePodLearning({ pod: { id: 'one' }, preferences: {}, campaigns: 'bad', posts: [null, {}, { id: 'broken', updated_at: 'invalid' }] }), []);
  const rows = workspace({ preferences: [null, { id: 'legacy', pod_id: 'one', preference_type: 'brand_direction', preference_value: '"Friendly"', created_at: '2026-10-01' }, { id: 'long', pod_id: 'one', preference_type: 'brand_direction', preference_value: { value: '<script>secret()</script><b>Friendly</b>\u0000 ' + 'x'.repeat(3000) }, created_at: '2026-10-02' }], posts: [{ id: 'foreign', pod_id: 'two', body: 'DO-NOT-SHOW', updated_at: '2026-10-03' }] });
  const events = learning.normalizePodLearning(rows);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.detail.length <= 500));
  assert.doesNotMatch(JSON.stringify(events), /<script>|secret\(\)|<b>|DO-NOT-SHOW/);
  assert.match(events[1].detail, /Friendly/);
  assert.deepEqual(learning.normalizePodLearning(rows, { limit: 0 }), []);
});

test('learning and snapshot restoration require Pod attribution and ignore timestamped malformed rows', () => {
  const rows = workspace({ preferences: [
    { id: 'missing-pod', preference_type: 'brand_direction', preference_value: 'Not attributed', created_at: '2026-10-01' },
    { id: 'bad-value', pod_id: 'one', preference_type: 'brand_direction', preference_value: [], created_at: '2026-10-01' },
    { id: 'unattributed-snapshot', preference_type: 'competitor_snapshot', preference_value: { summary: 'Missing Pod' }, created_at: '2026-10-09' },
    { id: 'legacy', pod_id: 'one', preference_type: 'competitor_snapshot', preference_value: JSON.stringify({ value: savedSnapshot({ summary: 'Saved legacy snapshot' }) }), created_at: '2026-10-02' },
  ], campaigns: [{ pod_id: 'one', created_at: '2026-10-03' }], posts: [{ pod_id: 'one', created_at: '2026-10-03' }] });
  const events = learning.normalizePodLearning(rows);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail, 'Saved legacy snapshot');
  assert.equal(learning.selectPodCompetitorSnapshot(rows.preferences, 'one').summary, 'Saved legacy snapshot');
});

test('unknown prototype-named preference types never create learning events', () => {
  const rows = workspace({ preferences: ['toString', '__proto__', 'constructor'].map((preference_type) => ({ id: preference_type, pod_id: 'one', preference_type, preference_value: 'Not a supported saved decision', created_at: '2026-10-01' })) });
  assert.deepEqual(learning.normalizePodLearning(rows), []);
});

function repository(client) {
  const source = readFileSync(new URL('../src/lib/podRepository.js', import.meta.url), 'utf8').replace(/import\s+{[\s\S]*?}\s+from\s+'[^']+';/g, '').replace(/export /g, '');
  const bindings = { supabase: client, supabaseConfigured: true, ...direction, ...state, ...learning };
  return new Function(...Object.keys(bindings), `${source}; return { loadPodWorkspace };`)(...Object.values(bindings));
}
test('repository reports a failed social_posts read and restores newest saved competitor/learning snapshots', async () => {
  let failPosts = true;
  const client = createClient('https://pod.test', 'public-test-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (url, init = {}) => {
    const parsed = new URL(url); const table = parsed.pathname.split('/').at(-1);
    assert.equal(parsed.searchParams.get(table === 'pods' ? 'id' : 'pod_id'), 'eq.one');
    const payload = table === 'pods' ? { id: 'one' } : table === 'pod_preferences' ? [
      { id: 'old', pod_id: 'one', preference_type: 'competitor_snapshot', active: true, preference_value: savedSnapshot({ summary: 'Old' }), created_at: '2026-10-01' },
      { id: 'new', pod_id: 'one', preference_type: 'competitor_snapshot', active: true, preference_value: { value: savedSnapshot({ summary: 'Newest' }) }, created_at: '2026-10-07' },
      { id: 'foreign', pod_id: 'two', preference_type: 'competitor_snapshot', active: true, preference_value: savedSnapshot({ summary: 'Foreign' }), created_at: '2026-10-08' },
    ] : new Headers(init.headers).get('accept')?.includes('object') ? null : [];
    return new Response(JSON.stringify(table === 'social_posts' && failPosts ? { message: 'denied' } : payload), { status: table === 'social_posts' && failPosts ? 403 : 200, headers: { 'content-type': 'application/json' } });
  } } });
  await assert.rejects(repository(client).loadPodWorkspace('one'), /social_posts/);
  failPosts = false;
  const loaded = await repository(client).loadPodWorkspace('one');
  assert.equal(loaded.competitorSnapshot.summary, 'Newest');
  assert.ok(loaded.learningEvents.length >= 2);
  assert.doesNotMatch(JSON.stringify(loaded.learningEvents), /Foreign/);
});

async function uiHarness(first, { request, load = async () => first, demoMode = false } = {}) {
  const slots = []; const effects = []; const cleanups = new Map(); let cursor = 0; let tree; let podId = 'one'; let requests = 0;
  const h = (type, props, ...children) => typeof type === 'function' ? type({ ...props, children }) : { type, props: props || {}, children: children.flat(Infinity).filter((child) => child != null && child !== false) };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; }, useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((dep, index) => dep !== slots[i][index])) { slots[i] = deps; effects.push(() => { cleanups.get(i)?.(); cleanups.set(i, fn()); }); } },
  };
  const modules = {
    react: hooks, 'react-router-dom': { Link: ({ children }) => h('a', {}, children), useParams: () => ({ podId }) }, 'lucide-react': new Proxy({}, { get: () => () => null }),
    '../lib/supabaseClient': { supabaseConfigured: true }, '../lib/podDirection': direction, '../lib/podState': state, '../lib/podLearning': learning,
    '../lib/plans': { getPlan }, '../lib/platforms': platforms, '../lib/podSetup': setup, '../lib/demoPod': demo,
    '../lib/aiClient': { requestCompetitorSnapshot: async (...args) => { requests++; return request(...args); } },
    '../lib/podRepository': { loadPodWorkspace: load }, '../components/pod/PodCommandPalette': { default: () => null }, '../components/pod/PodModal': { default: () => null },
  };
  let source = readFileSync(new URL('../src/pages/PodWorkspace.jsx', import.meta.url), 'utf8');
  source = source.replace(/import\s+({[\s\S]*?}|[\w]+)\s+from\s+'([^']+)';/g, (_, names, name) => names.startsWith('{') ? `const ${names} = modules[${JSON.stringify(name)}];` : `const ${names} = modules[${JSON.stringify(name)}].default;`).replace(/import\s+'[^']+';/g, '').replace('export default function PodWorkspace', 'function PodWorkspace');
  const { code } = await transformWithOxc(source, 'PodWorkspace.jsx', { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } });
  const renderLive = new Function('modules', 'h', 'window', 'Fragment', `${code}; return ${demoMode ? 'DemoPodShowcase' : 'LivePodWorkspace'};`)(modules, h, { addEventListener() {}, removeEventListener() {}, setTimeout() { return 1; }, clearTimeout() {} }, 'fragment');
  const render = () => { cursor = 0; tree = renderLive({ session: { access_token: 'own-token', user: { email: 'owner@test' } }, subscription: { tier: 'starter' } }); };
  const flush = async () => { render(); while (effects.length) { effects.splice(0).forEach((effect) => effect()); await new Promise((done) => setImmediate(done)); render(); } };
  const nodes = (node = tree) => typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'object' ? (node.children || []).map(text).join(' ') : String(node);
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node).trim() === label);
  await flush();
  return { flush, nodes, text, button, requestCount: () => requests, snapshot: () => structuredClone(slots), unmount() { for (const cleanup of cleanups.values()) cleanup?.(); }, async navigate(id) { podId = id; await flush(); }, async tab(label) { assert.ok(button(label), `missing ${label} tab`); button(label).props.onClick(); await flush(); } };
}

test('live navigation has 15 items and shows persisted competitor and recent learning data without running services', async () => {
  const ui = await uiHarness(workspace({ competitorSnapshot: savedSnapshot(), learningEvents: [{ id: 'saved', type: 'brand_direction', title: 'Direction saved', detail: 'Owner chose practical', occurredAt: '2026-10-07', source: 'user_override' }] }));
  const nav = ui.nodes().find((node) => node.type === 'aside');
  assert.equal(ui.nodes(nav).filter((node) => node.type === 'button').length, 15);
  await ui.tab('Competitor Watch');
  assert.match(ui.text(), /On-demand public snapshot — refresh to check again/);
  assert.match(ui.text(), /Saved positioning/);
  assert.equal(ui.nodes().filter((node) => node.type === 'input' && node.props.type === 'url').length, 3);
  await ui.tab('Learning History');
  assert.match(ui.text(), /Owner chose practical/);
  assert.match(ui.text(), /recent saved activity/i);
  assert.match(ui.text(), /guide future Pod output/i);
  assert.equal(ui.requestCount(), 0);
});

test('reload skips malformed newer competitor data and renders an older valid snapshot without URL button crashes', async () => {
  const malformed = { summary: 'Legacy malformed', competitors: [{ url: 42 }] };
  const older = savedSnapshot({ summary: 'Valid older snapshot', competitors: [{ url: ' HTTPS://8.8.8.8 ', positioning: 'Older saved positioning', public_strengths: ['Materials'], public_gaps: ['Care'] }] });
  const preferences = [
    { id: 'valid', pod_id: 'one', preference_type: 'competitor_snapshot', preference_value: { value: older }, active: true, created_at: '2026-10-01' },
    { id: 'malformed', pod_id: 'one', preference_type: 'competitor_snapshot', preference_value: malformed, active: true, created_at: '2026-10-07' },
  ];
  // The stale direct cached value must not bypass validation of persisted rows.
  const ui = await uiHarness(workspace({ preferences, competitorSnapshot: malformed }));
  await ui.tab('Competitor Watch');
  assert.match(ui.text(), /Valid older snapshot|Older saved positioning/);
  assert.doesNotMatch(ui.text(), /Legacy malformed/);
  const inputs = ui.nodes().filter((node) => node.type === 'input' && node.props.type === 'url');
  assert.deepEqual(inputs.map((node) => node.props.value), ['https://8.8.8.8/', '', '']);
  assert.equal(ui.button('Check public pages').props.disabled, false);
  assert.equal(ui.requestCount(), 0);
  const onlyMalformed = await uiHarness(workspace({ preferences: preferences.slice(1) }));
  await onlyMalformed.tab('Competitor Watch');
  assert.match(onlyMalformed.text(), /No saved public snapshot/);
  assert.equal(onlyMalformed.button('Check public pages').props.disabled, true);
});

test('restored competitor snapshots require complete typed structure before any URL enters input state', () => {
  const invalid = [
    { summary: 'Legacy malformed', competitors: [{ url: 42 }] },
    savedSnapshot({ competitors: [{ ...savedSnapshot().competitors[0], url: 42 }] }),
    savedSnapshot({ competitors: [{ ...savedSnapshot().competitors[0], url: 'javascript:alert(1)' }] }),
    savedSnapshot({ competitors: Array.from({ length: 4 }, (_, index) => ({ ...savedSnapshot().competitors[0], url: `https://8.8.8.8/${index}` })) }),
    savedSnapshot({ competitors: [{ ...savedSnapshot().competitors[0], public_strengths: [{ toString: null }] }] }),
    savedSnapshot({ summary: { toString: null } }), savedSnapshot({ evidence: null }), savedSnapshot({ confidence: '0.8' }), savedSnapshot({ checked_at: 'invalid' }),
  ];
  for (const value of invalid) {
    const rows = [{ pod_id: 'one', preference_type: 'competitor_snapshot', preference_value: value, created_at: '2026-10-07' }];
    assert.equal(learning.selectPodCompetitorSnapshot(rows, 'one'), null);
  }
});

test('malformed platform preferences are isolated before coercion while valid saved activity remains visible', () => {
  const malformed = [{ platforms: [{ toString: null }] }, { platforms: [42] }, { platforms: [null] }, { platforms: [[]] }, { platforms: 'email' }, 'email', 42, null, [], { platforms: ['email', { toString: null }] }];
  const rows = workspace({ preferences: [
    ...malformed.map((preference_value, index) => ({ id: `bad-${index}`, pod_id: 'one', preference_type: 'platform_selection', preference_value, created_at: '2026-10-07' })),
    { id: 'good-platforms', pod_id: 'one', preference_type: 'platform_selection', preference_value: { platforms: ['email', 'instagram'] }, created_at: '2026-10-06' },
    { id: 'good-empty', pod_id: 'one', preference_type: 'platform_selection', preference_value: { platforms: [] }, created_at: '2026-10-05' },
    { id: 'good-direction', pod_id: 'one', preference_type: 'brand_direction', preference_value: { value: 'Friendly direction' }, created_at: '2026-10-04' },
  ] });
  const events = learning.normalizePodLearning(rows);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.detail), ['email, instagram', 'No platforms selected', 'Friendly direction']);
});

test('per-type learning validation skips malformed supported rows without losing valid rows', () => {
  const rows = workspace({ preferences: [
    { id: 'direction-bad', pod_id: 'one', preference_type: 'brand_direction', preference_value: { value: { toString: null } }, created_at: '2026-10-07' },
    { id: 'website-bad', pod_id: 'one', preference_type: 'website_intelligence', preference_value: { summary: ['Not a string'] }, created_at: '2026-10-07' },
    { id: 'budget-bad', pod_id: 'one', preference_type: 'budget_recommendation_decision', preference_value: { decision: { toString: null } }, created_at: '2026-10-07' },
    { id: 'snapshot-bad', pod_id: 'one', preference_type: 'competitor_snapshot', preference_value: { summary: 'Incomplete' }, created_at: '2026-10-07' },
    { id: 'website-good', pod_id: 'one', preference_type: 'website_intelligence', preference_value: { summary: 'Saved website observation' }, created_at: '2026-10-06' },
    { id: 'budget-good', pod_id: 'one', preference_type: 'budget_recommendation_decision', preference_value: { decision: 'approved' }, created_at: '2026-10-05' },
  ], budgets: [
    { id: 'malformed-budget', pod_id: 'one', planned_budget: { toString: null }, created_at: '2026-10-07' },
    { id: 'valid-budget', pod_id: 'one', planned_budget: '120.00', created_at: '2026-10-04' },
  ] });
  const events = learning.normalizePodLearning(rows);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.type), ['website_intelligence', 'budget_recommendation_decision', 'budget']);
});

test('competitor request is explicit and old completion cannot mutate B, returned A, or unmounted state', async () => {
  for (const finish of ['B', 'A', 'unmount']) {
    let resolve; const waiting = new Promise((done) => { resolve = done; }); let args;
    const a = workspace(); const b = workspace({ pod: { id: 'two', pod_name: 'Second Pod' } });
    const ui = await uiHarness(a, { load: async (id) => id === 'one' ? a : b, request: (...value) => { args = value; return waiting; } });
    await ui.tab('Competitor Watch');
    const input = ui.nodes().find((node) => node.type === 'input' && node.props.type === 'url');
    input.props.onChange({ target: { value: 'https://8.8.8.8' } }); await ui.flush();
    assert.equal(ui.requestCount(), 0);
    const pending = ui.button('Check public pages').props.onClick();
    assert.equal(ui.requestCount(), 1);
    assert.equal(args[0].podId, 'one'); assert.equal(args[0].accessToken, 'own-token');
    if (finish === 'unmount') ui.unmount(); else { await ui.navigate('two'); if (finish === 'A') await ui.navigate('one'); }
    const before = ui.snapshot();
    resolve({ ok: true, saved: true, snapshot: { summary: 'OLD-COMPLETION', competitors: [], evidence: [], opportunities: [], checked_at: '2026-10-07' } });
    await pending;
    assert.deepEqual(ui.snapshot(), before);
  }
});

test('demo competitor and learning tabs are filled static fiction with no interactive service controls', async () => {
  const ui = await uiHarness(null, { demoMode: true, request: () => { throw new Error('demo must never request'); } });
  for (const label of ['Competitor Watch', 'Learning History']) {
    await ui.tab(label);
    assert.match(ui.text(), /Fictional sample/);
    assert.ok(ui.nodes().some((node) => node.type === 'article'));
    assert.equal(ui.nodes().some((node) => ['input', 'form', 'textarea', 'select'].includes(node.type)), false);
    const panel = ui.nodes().find((node) => node.props.role === 'tabpanel');
    assert.equal(ui.nodes(panel).some((node) => node.type === 'button'), false);
  }
  assert.equal(ui.requestCount(), 0);
});
