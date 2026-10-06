import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { getPlan } from '../src/lib/plans.js';
import * as platforms from '../src/lib/platforms.js';
import * as direction from '../src/lib/podDirection.js';
import * as setup from '../src/lib/podSetup.js';
import * as demo from '../src/lib/demoPod.js';
import * as state from '../src/lib/podState.js';

// Exercise the real Supabase query builder against a deterministic HTTP boundary.
function database(seed = {}, { fail, empty, wait, failMessage } = {}) {
  const tables = structuredClone(seed);
  const requests = [];
  const client = createClient('https://pod-state.example', 'public-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      const parsed = new URL(url);
      const table = parsed.pathname.split('/').at(-1);
      const method = options.method || 'GET';
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({ table, method, payload, query: parsed.searchParams, headers: options.headers });
      if (wait && method !== 'GET') await wait;
      if (fail === `${table}:${method}`) return new Response(JSON.stringify({ message: failMessage || `${table} denied` }), { status: 403 });
      const rows = tables[table] ||= [];
      const matches = (row) => [...parsed.searchParams].every(([key, filter]) => {
        if (['select', 'order', 'on_conflict', 'limit'].includes(key)) return true;
        const dot = filter.indexOf('.');
        const op = filter.slice(0, dot);
        const value = filter.slice(dot + 1);
        if (op === 'eq') return String(row[key]) === value;
        if (op === 'neq') return String(row[key]) !== value;
        if (op === 'lt') return row[key] < value;
        if (op === 'lte') return row[key] <= value;
        if (op === 'gte') return row[key] >= value;
        throw new Error(`Unexpected filter: ${filter}`);
      });
      let result;
      if (method === 'GET') result = rows.filter(matches);
      else if (method === 'PATCH') {
        result = rows.filter(matches).map((row) => Object.assign(row, payload));
      } else {
        result = (Array.isArray(payload) ? payload : [payload]).map((row) => {
          const existing = parsed.searchParams.has('on_conflict') && rows.find((entry) => entry.pod_id === row.pod_id);
          if (existing) return Object.assign(existing, row);
          const inserted = { id: `row-${rows.length}`, created_at: '2026-10-07T01:00:00Z', ...row };
          rows.push(inserted);
          return inserted;
        });
      }
      if (empty === `${table}:${method}`) result = [];
      const singular = new Headers(options.headers).get('accept')?.includes('object');
      return new Response(JSON.stringify(singular ? result[0] || null : result), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    } },
  });
  return { client, tables, requests };
}

test('wrong Pod scoping: platform selection deduplicates keys and leaves other Pods active', async () => {
  const db = database({ pod_preferences: [
    { id: 'old', pod_id: 'one', preference_type: 'platform_selection', active: true, created_at: '2026-09-01' },
    { id: 'other', pod_id: 'two', preference_type: 'platform_selection', active: true },
    { id: 'direction', pod_id: 'one', preference_type: 'direction_override', active: true },
  ] });
  const row = await state.persistPlatformSelection(db.client, 'one', ['instagram', ' instagram ', 'email']);
  assert.deepEqual(row.preference_value, { platforms: ['instagram', 'email'] });
  assert.equal(row.source, 'user_override');
  assert.equal(row.active, true);
  assert.equal(db.tables.pod_preferences[0].active, false);
  assert.equal(db.tables.pod_preferences[1].active, true);
  assert.equal(db.tables.pod_preferences[2].active, true);
});

test('invalid platform input cannot issue a write; explicitly empty selection is valid', async () => {
  const db = database();
  for (const keys of [null, [''], ['   '], [12]]) await assert.rejects(state.persistPlatformSelection(db.client, 'one', keys));
  await assert.rejects(state.persistPlatformSelection(db.client, '', ['email']));
  assert.equal(db.requests.length, 0);
  assert.deepEqual((await state.persistPlatformSelection(db.client, 'one', [])).preference_value, { platforms: [] });
});

test('unconfirmed platform write never deactivates the previously saved selection', async () => {
  for (const options of [{ fail: 'pod_preferences:POST' }, { empty: 'pod_preferences:POST' }]) {
    const db = database({}, options);
    await assert.rejects(state.persistPlatformSelection(db.client, 'one', ['email']));
    assert.equal(db.requests.some((request) => request.method === 'PATCH'), false);
  }
});

test('duplicate month: repeated calendar generation returns existing Pod rows without deletion', async () => {
  const db = database({ calendar_items: [{ id: 'other', pod_id: 'two', scheduled_date: '2026-10-01' }] });
  const items = [{ platform: 'email', scheduled_date: '2026-10-05', content_type: 'Post', caption: 'Own draft', approved: false, status: 'draft' }];
  const first = await state.persistCalendarItems(db.client, 'one', items);
  const second = await state.persistCalendarItems(db.client, 'one', items);
  assert.deepEqual(second, first);
  assert.equal(first[0].pod_id, 'one');
  assert.equal(first[0].status, 'draft');
  assert.equal(first[0].approved, false);
  assert.equal(db.requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(db.requests.some((request) => request.method === 'DELETE'), false);
  assert.equal(db.requests[0].query.get('scheduled_date'), 'gte.2026-10-01');
  assert.ok([...db.requests[0].query].some(([key, value]) => key === 'scheduled_date' && value === 'lt.2026-11-01'));
});

test('invalid calendar dates or mixed months cannot write a partial calendar', async () => {
  const db = database();
  for (const dates of [['2026-02-30'], ['2026-10-01', '2026-11-01']]) {
    await assert.rejects(state.persistCalendarItems(db.client, 'one', dates.map((scheduled_date) => ({ platform: 'email', scheduled_date, content_type: 'Post' }))));
  }
  assert.equal(db.requests.length, 0);
});

test('calendar generation uses saved drafts, selected platforms and both plan limits', () => {
  const rows = state.buildCalendarItems({ month: '2026-10', posts: [
    { platformKey: 'email', content: 'Our email', contentStyle: 'Email' },
    { platformKey: 'instagram', content: 'Our image', contentStyle: 'Image' },
  ], platformKeys: ['email'], weeklyPostingDays: 2, monthlyContentDays: 3 });
  assert.deepEqual(rows.map((row) => row.scheduled_date), ['2026-10-05', '2026-10-07', '2026-10-12']);
  assert.ok(rows.every((row) => row.platform === 'email' && row.caption === 'Our email' && row.status === 'draft' && row.approved === false));
  assert.deepEqual(state.buildCalendarItems({ month: '2026-10', posts: [{ platformKey: 'email', content: 'Draft' }], platformKeys: ['email'], weeklyPostingDays: 0, monthlyContentDays: 0 }), []);
});

test('wrong Pod scoping: campaign decisions update only the named campaign in the requested Pod', async () => {
  const db = database({ campaigns: [{ id: 'campaign', pod_id: 'one', name: 'Own', status: 'draft' }, { id: 'campaign', pod_id: 'two', name: 'Other', status: 'draft' }] });
  const saved = await state.persistCampaignDecision(db.client, 'one', { campaignId: 'campaign', name: 'Own', status: 'approved' });
  assert.equal(saved.status, 'approved');
  assert.equal(db.tables.campaigns[1].status, 'draft');
  await assert.rejects(state.persistCampaignDecision(db.client, 'one', { name: 'Bad', status: 'published' }));
  const inserted = await state.persistCampaignDecision(db.client, 'one', { name: 'Launch', status: 'draft', brief: { strategy: 'Local' }, startsOn: '2026-10-01' });
  assert.equal(inserted.pod_id, 'one');
  assert.equal(inserted.starts_on, '2026-10-01');
});

test('unconfirmed campaign write stays pending until server response and rejects invisible updates', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const db = database({}, { wait });
  let confirmed = false;
  const operation = state.persistCampaignDecision(db.client, 'one', { name: 'Launch', status: 'approved' }).then((row) => { confirmed = true; return row; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmed, false);
  release();
  assert.equal((await operation).status, 'approved');
  const invisible = database();
  await assert.rejects(state.persistCampaignDecision(invisible.client, 'one', { campaignId: 'absent', name: 'Launch', status: 'approved' }), /confirmed/);
});

test('invalid amount: negative, non-finite and non-numeric planned budgets never write', async () => {
  const db = database();
  for (const amount of [-1, NaN, Infinity, '200', null]) await assert.rejects(state.persistBudgetPlan(db.client, 'one', { plannedBudget: amount }));
  assert.equal(db.requests.length, 0);
  await state.persistBudgetPlan(db.client, 'one', { plannedBudget: 0, notes: 'No spend authorised', spend_used: 847, revenue: 4230 });
  await state.persistBudgetPlan(db.client, 'one', { plannedBudget: 123.45, notes: 'Plan only' });
  assert.equal(db.tables.budgets.length, 1);
  assert.equal(db.tables.budgets[0].planned_budget, 123.45);
  assert.equal(db.requests[0].query.get('on_conflict'), 'pod_id');
  assert.equal('spend_used' in db.requests[0].payload, false);
  assert.equal('revenue' in db.requests[0].payload, false);
});

test('budget recommendation decision persists a plan-only event without provider or budget writes', async () => {
  const db = database();
  const saved = await state.persistPreferenceDecision(db.client, 'one', 'budget_recommendation_decision', { decision: 'approved', scope: 'plan_only' });
  assert.deepEqual(saved.preference_value, { decision: 'approved', scope: 'plan_only' });
  assert.equal(saved.pod_id, 'one');
  assert.deepEqual(db.requests.map((request) => request.table), ['pod_preferences']);
});

test('explicit observance: religion defaults off, only boolean true enables it, country is two-letter', async () => {
  const db = database();
  let saved = await state.persistHolidayPreference(db.client, 'one', { country_code: 'au', include_religious_observances: 'true', selected_observances: ['Not guessed'] });
  assert.equal(saved.country_code, 'AU');
  assert.equal(saved.include_religious_observances, false);
  assert.deepEqual(saved.selected_observances, []);
  saved = await state.persistHolidayPreference(db.client, 'one', { country_code: 'AU', include_religious_observances: true, selected_observances: ['User supplied'] });
  assert.equal(saved.include_religious_observances, true);
  assert.deepEqual(saved.selected_observances, ['User supplied']);
  assert.equal(db.tables.holiday_preferences.length, 1);
  await assert.rejects(state.persistHolidayPreference(db.client, 'one', { country_code: 'Australia' }));
});

test('stale-state selection: restore newest active preferences, retain explicit empty selection and normalize rows', () => {
  const restored = state.restoreOperationalState({ pod: { id: 'one' }, preferences: [
    { pod_id: 'one', active: true, preference_type: 'platform_selection', created_at: '2026-10-06', preference_value: { platforms: ['email'] } },
    { pod_id: 'one', active: true, preference_type: 'platform_selection', created_at: '2026-10-07', preference_value: { platforms: [] } },
    { pod_id: 'one', active: false, preference_type: 'platform_selection', created_at: '2026-10-08', preference_value: { platforms: ['tiktok'] } },
    { pod_id: 'two', active: true, preference_type: 'platform_selection', created_at: '2026-10-09', preference_value: { platforms: ['other'] } },
    { pod_id: 'one', active: true, preference_type: 'budget_recommendation_decision', created_at: '2026-10-07', preference_value: { decision: 'rejected', scope: 'plan_only' } },
  ], campaigns: [{ id: 'new', created_at: '2026-10-07', status: 'approved' }, { id: 'old', created_at: '2026-10-06', status: 'draft' }],
  budgets: [{ planned_budget: '250.00' }], calendarItems: [{ scheduled_date: '2026-10-07', status: 'draft' }], holidayPreferences: [{ country_code: 'AU', include_religious_observances: false }] });
  assert.deepEqual(restored.platformKeys, []);
  assert.equal(restored.campaign.id, 'new');
  assert.equal(restored.budget.planned_budget, 250);
  assert.equal(restored.calendarItems.length, 1);
  assert.equal(restored.holidayPreference.include_religious_observances, false);
  assert.equal(restored.budgetDecision, 'rejected');
  assert.equal(state.restoreOperationalState({}).platformKeys, null);
});

test('failing operational collection is identified rather than silently restored empty', async () => {
  const db = database({ calendar_items: [{ pod_id: 'one', scheduled_date: '2026-10-07' }, { pod_id: 'two' }] });
  const restored = await state.loadOperationalCollections(db.client, 'one');
  assert.equal(restored.calendarItems.length, 1);
  for (const table of ['calendar_items', 'campaigns', 'budgets', 'holiday_preferences', 'ad_analysis']) {
    const rejected = database({}, { fail: `${table}:GET` });
    await assert.rejects(state.loadOperationalCollections(rejected.client, 'one'), new RegExp(table));
  }
});

// Run the real LivePodWorkspace handlers/rendering with controlled hook state.
// The only substituted side effects are hook scheduling and repository/network I/O.
async function workspaceHarness(workspace, services = {}) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let tree;
  const h = (type, props, ...children) => typeof type === 'function'
    ? type({ ...props, children }) : { type, props: props || {}, children: children.flat(Infinity).filter((child) => child != null && child !== false) };
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn, deps) { const index = cursor++; if (!slots[index] || deps.some((dep, i) => dep !== slots[index][i])) { slots[index] = deps; effects.push(fn); } },
  };
  const repository = {
    loadPodWorkspace: async () => workspace,
    savePlatformSelection: async () => {}, saveCalendarItems: async () => [], saveCampaignDecision: async () => {},
    saveBudgetPlan: async () => {}, savePreferenceDecision: async () => {}, saveHolidayPreference: async () => {},
    ...services,
  };
  const modules = {
    react: hooks, 'react-router-dom': { Link: ({ children }) => h('a', {}, children), useParams: () => ({ podId: 'one' }) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '../lib/supabaseClient': { supabaseConfigured: true }, '../lib/podDirection': direction,
    '../lib/plans': { getPlan }, '../lib/platforms': platforms, '../lib/podSetup': setup,
    '../lib/aiClient': {}, '../lib/demoPod': demo, '../lib/podRepository': repository, '../lib/podState': state,
    '../components/pod/PodCommandPalette': { default: () => null }, '../components/pod/PodModal': { default: () => null },
  };
  let source = readFileSync(new URL('../src/pages/PodWorkspace.jsx', import.meta.url), 'utf8');
  source = source.replace(/import\s+({[\s\S]*?}|[\w]+)\s+from\s+'([^']+)';/g, (_, names, module) => names.startsWith('{')
    ? `const ${names} = modules[${JSON.stringify(module)}];` : `const ${names} = modules[${JSON.stringify(module)}].default;`)
    .replace(/import\s+'[^']+';/g, '').replace('export default function PodWorkspace', 'function PodWorkspace');
  const { code } = await transformWithOxc(source, 'PodWorkspace.jsx', { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } });
  const windowStub = { addEventListener() {}, removeEventListener() {}, setTimeout() { return 1; }, clearTimeout() {} };
  const renderLive = new Function('modules', 'h', 'window', 'Fragment', `${code}; return LivePodWorkspace;`)(modules, h, windowStub, 'fragment');
  const render = () => { cursor = 0; tree = renderLive({ session: { user: { email: 'owner@example.test' } }, subscription: { tier: 'starter' } }); return tree; };
  const flush = async () => { render(); while (effects.length) { effects.splice(0).forEach((effect) => effect()); await new Promise((resolve) => setImmediate(resolve)); render(); } };
  const nodes = (node = tree) => typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap((child) => nodes(child))];
  const text = (node = tree) => typeof node === 'object' ? (node.children || []).map(text).join(' ') : String(node);
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node).trim() === label);
  await flush();
  return { render, flush, nodes, text, button, async tab(label) { button(label).props.onClick(); await flush(); } };
}

function savedWorkspace(extra = {}) {
  return {
    pod: { id: 'one', pod_name: 'Our launch', target_country: 'Australia', status: 'direction_locked' },
    analysis: { social_recommendations: '["email"]', content_ideas: '[]', brand_summary: 'Our brand' },
    preferences: [{ active: true, preference_type: 'platform_selection', preference_value: { platforms: ['instagram'] }, created_at: '2026-10-07' }],
    messages: [], posts: [], assets: [], campaigns: [], calendarItems: [], budgets: [], holidayPreferences: [], ...extra,
  };
}

test('live stale-state selection: saved platform wins over analysis and failed toggle reverts with an error', async () => {
  let call;
  const ui = await workspaceHarness(savedWorkspace(), { savePlatformSelection: async (...args) => { call = args; throw new Error('Selection denied'); } });
  await ui.tab('Social accounts');
  const label = ui.nodes().find((node) => node.type === 'label' && ui.text(node).includes('Instagram'));
  const checkbox = label.children.find((node) => node.type === 'input');
  assert.equal(checkbox.props.checked, true);
  await checkbox.props.onChange();
  await ui.flush();
  assert.deepEqual(call, ['one', []]);
  const restored = ui.nodes().find((node) => node.type === 'label' && ui.text(node).includes('Instagram'));
  assert.equal(restored.children.find((node) => node.type === 'input').props.checked, true);
  assert.match(ui.text(), /Selection denied/);
});

test('live unconfirmed write: campaign status changes only after persistence, budget and observance saves use scoped payloads', async () => {
  let resolveCampaign;
  const waiting = new Promise((resolve) => { resolveCampaign = resolve; });
  const calls = [];
  const ui = await workspaceHarness(savedWorkspace(), {
    saveCampaignDecision: async (...args) => { calls.push(['campaign', ...args]); await waiting; return { id: 'campaign', name: 'Our launch campaign', status: 'approved' }; },
    saveBudgetPlan: async (...args) => { calls.push(['budget', ...args]); return { planned_budget: args[1].plannedBudget }; },
    saveHolidayPreference: async (...args) => { calls.push(['holiday', ...args]); return { ...args[1] }; },
    savePreferenceDecision: async (...args) => { calls.push(['decision', ...args]); return {}; },
  });
  await ui.tab('Campaigns');
  const operation = ui.button('Approve campaign').props.onClick();
  await ui.flush();
  assert.ok(ui.nodes().some((node) => node.type === 'span' && ui.text(node) === 'Draft'));
  resolveCampaign();
  await operation;
  await ui.flush();
  assert.ok(ui.nodes().some((node) => node.type === 'span' && ui.text(node) === 'Approved'));
  await ui.tab('Budget & ads');
  assert.doesNotMatch(ui.text(), /\$847|\$4,230|4\.99x/);
  const input = ui.nodes().find((node) => node.type === 'input' && node.props.type === 'number');
  assert.ok(input, 'planned budget input is absent');
  input.props.onChange({ target: { value: '150' } });
  await ui.flush();
  await ui.button('Save budget plan').props.onClick();
  await ui.button('Approve recommendation').props.onClick();
  await ui.flush();
  assert.equal(calls.find((call) => call[0] === 'budget')[2].plannedBudget, 150);
  assert.deepEqual(calls.find((call) => call[0] === 'decision').slice(1), ['one', 'budget_recommendation_decision', { decision: 'approved', scope: 'plan_only' }]);
  assert.doesNotMatch(ui.text(), /recorded in this session/);
  await ui.tab('Calendar');
  await ui.nodes().find((node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  assert.equal(calls.find((call) => call[0] === 'holiday')[2].country_code, 'AU');
  assert.equal(calls.find((call) => call[0] === 'holiday')[2].include_religious_observances, true);
  assert.deepEqual(calls.find((call) => call[0] === 'holiday')[2].selected_observances, []);
});

test('live duplicate month: saved rows render after reload and repeated calendar generation does not write', async () => {
  const db = database();
  const workspace = savedWorkspace({ posts: [{ id: 'post', platform: 'instagram', body: 'Our saved campaign caption', status: 'draft' }] });
  const service = { saveCalendarItems: (id, items) => state.persistCalendarItems(db.client, id, items) };
  const ui = await workspaceHarness(workspace, service);
  await ui.tab('Calendar');
  await ui.button('Generate calendar').props.onClick();
  await ui.flush();
  assert.match(ui.text(), /Our saved campaign caption/);
  assert.equal(db.requests.filter((request) => request.method === 'POST').length, 1);
  const count = db.tables.calendar_items.length;
  assert.ok(count > 0 && count <= 10);
  await ui.button('Generate calendar').props.onClick();
  assert.equal(db.tables.calendar_items.length, count);
  const reloaded = await workspaceHarness({ ...workspace, calendarItems: db.tables.calendar_items }, service);
  await reloaded.tab('Calendar');
  assert.match(reloaded.text(), /Our saved campaign caption/);
  await reloaded.button('Generate calendar').props.onClick();
  assert.equal(db.requests.filter((request) => request.method === 'POST').length, 1);
});

test('live reload restores approved campaign, saved budget and decision, and explicit observance', async () => {
  const ui = await workspaceHarness(savedWorkspace({
    campaigns: [{ id: 'campaign', name: 'Our persisted launch', status: 'approved' }],
    budgets: [{ planned_budget: '350.00', notes: 'Plan only' }],
    holidayPreferences: [{ country_code: 'AU', include_religious_observances: true, selected_observances: ['User selected'] }],
    preferences: [{ active: true, preference_type: 'budget_recommendation_decision', preference_value: { decision: 'rejected' } }],
  }));
  await ui.tab('Campaigns');
  assert.match(ui.text(), /Our persisted launch/);
  assert.ok(ui.nodes().some((node) => node.type === 'span' && ui.text(node) === 'Approved'));
  await ui.tab('Budget & ads');
  assert.match(ui.text(), /AUD 350.00/);
  assert.match(ui.text(), /rejected/);
  assert.equal(ui.nodes().find((node) => node.type === 'input' && node.props.type === 'number').props.value, '350');
  await ui.tab('Calendar');
  assert.equal(ui.nodes().find((node) => node.type === 'input' && node.props.type === 'checkbox').props.checked, true);
});

function repositoryHarness(client) {
  const source = readFileSync(new URL('../src/lib/podRepository.js', import.meta.url), 'utf8')
    .replace(/import\s+{[\s\S]*?}\s+from\s+'[^']+';/g, '').replace(/export /g, '');
  const bindings = { supabase: client, supabaseConfigured: true, ...state, ...direction };
  return new Function(...Object.keys(bindings), `${source}; return { loadPodWorkspace, saveBudgetPlan };`)(...Object.values(bindings));
}

test('repository returns all operational collections with Pod scoping and names preference-read failures', async () => {
  const db = database({ pods: [{ id: 'one' }], campaigns: [{ pod_id: 'one', status: 'approved' }, { pod_id: 'two' }], budgets: [{ pod_id: 'one', planned_budget: 20 }] });
  const repository = repositoryHarness(db.client);
  const loaded = await repository.loadPodWorkspace('one');
  assert.equal(loaded.campaigns.length, 1);
  assert.equal(loaded.budgets[0].planned_budget, 20);
  assert.deepEqual(loaded.calendarItems, []);
  assert.deepEqual(loaded.holidayPreferences, []);
  assert.deepEqual(loaded.adAnalysis, []);
  await repository.saveBudgetPlan('one', { plannedBudget: 30 });
  assert.equal(db.tables.budgets[0].planned_budget, 30);
  const failed = database({ pods: [{ id: 'one' }] }, { fail: 'pod_preferences:GET', failMessage: 'permission denied' });
  await assert.rejects(repositoryHarness(failed.client).loadPodWorkspace('one'), /pod_preferences/);
});
