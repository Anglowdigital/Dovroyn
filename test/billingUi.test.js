import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import {
  PLAN_CURRENCY,
  PLAN_ENTITLEMENTS,
  formatPlanPrice,
  getPlanSelection,
  getPlanSelectionQuery,
} from '../src/lib/plans.js';
import { purchaseReturnPath } from '../src/lib/purchaseConversion.js';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const accountSource = readFileSync(new URL('../src/pages/Account.jsx', import.meta.url), 'utf8');
const checkoutSource = readFileSync(new URL('../src/components/CheckoutButton.jsx', import.meta.url), 'utf8');
const confirmedPrices = {
  starter: [89, 855, 'AUD $89', 'AUD $855'],
  growth: [249, 2390, 'AUD $249', 'AUD $2,390'],
  pro: [599, 5750, 'AUD $599', 'AUD $5,750'],
  scale: [1299, 12470, 'AUD $1,299', 'AUD $12,470'],
};
const confirmedWeeklyDays = { starter: 2, growth: 3, pro: 6, scale: 7 };

function h(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== false && child != null) };
}
function nodes(tree) {
  return typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : [];
}
function text(tree) {
  return typeof tree === 'object' ? tree.children.map(text).join(' ') : String(tree);
}
function hooks() {
  const values = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!Object.hasOwn(values, index)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], (value) => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  };
  return { useState, useRef: (initial) => useState({ current: initial })[0], reset: () => { cursor = 0; } };
}
async function compile(source, name, bindings = {}) {
  const { code } = await transformWithOxc(source, `${name}.jsx`, { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } });
  return new Function('h', 'Fragment', ...Object.keys(bindings), `${code}; return ${name};`)(h, 'Fragment', ...Object.values(bindings));
}

test('all eight catalog prices match the confirmed AUD Stripe amounts', () => {
  assert.equal(PLAN_CURRENCY, 'AUD');
  for (const [tier, [monthly, yearly, monthlyLabel, yearlyLabel]] of Object.entries(confirmedPrices)) {
    assert.equal(PLAN_ENTITLEMENTS[tier].monthlyPrice, monthly);
    assert.equal(PLAN_ENTITLEMENTS[tier].yearlyPrice, yearly);
    assert.equal(formatPlanPrice(tier, 'monthly'), monthlyLabel);
    assert.equal(formatPlanPrice(tier, 'yearly'), yearlyLabel);
  }
  assert.equal(formatPlanPrice('free'), 'AUD $0');
});

test('plan continuation accepts only paid tiers and supported billing intervals', () => {
  for (const tier of Object.keys(confirmedPrices)) {
    for (const billing of ['monthly', 'yearly']) {
      assert.deepEqual(getPlanSelection(getPlanSelectionQuery(tier, billing)), { tier, billing });
    }
  }
  assert.deepEqual(getPlanSelection('?plan=starter'), { tier: 'starter', billing: 'monthly' });
  for (const search of ['', '?plan=free', '?plan=unknown', '?plan=__proto__', '?plan=starter&billing=weekly', '?returnTo=https://example.test']) {
    assert.equal(getPlanSelection(search), null, search);
  }
  assert.equal(getPlanSelectionQuery('https://example.test', 'yearly'), '');
  assert.equal(getPlanSelectionQuery('starter', 'weekly'), '');
});

const pricingConfig = appSource.slice(appSource.indexOf('const PRICING_TIERS = ['), appSource.indexOf('const POD_TABS = ['));
const pricingTiers = new Function('PLAN_ENTITLEMENTS', 'formatPlanPrice', `${pricingConfig}; return { PRICING_TIERS, PRICING_PAGE_TIERS };`)(PLAN_ENTITLEMENTS, formatPlanPrice);

for (const surface of ['homepage', 'pricing']) {
  test(`${surface} renders both AUD prices and passes its selected interval and session to checkout`, async () => {
    const session = { access_token: 'owner-test-token' };
    let source;
    let name;
    if (surface === 'homepage') {
      const start = appSource.indexOf('<section className="pricing-section">');
      const end = appSource.indexOf('</section>', start) + '</section>'.length;
      source = `function HomePrices({ session, billing }) { return (${appSource.slice(start, end)}); }`;
      name = 'HomePrices';
    } else {
      source = appSource.slice(appSource.indexOf('function PricingPage('), appSource.indexOf('function LegalPageShell('));
      name = 'PricingPage';
    }
    const state = hooks();
    const Component = await compile(source, name, {
      ...pricingTiers, PLAN_ENTITLEMENTS, getPlanSelection,
      useState: state.useState, useEffect: () => {},
      useLocation: () => ({ search: '?plan=growth&billing=yearly' }),
      BillingToggle: 'BillingToggle', CheckoutButton: 'CheckoutButton', NavLink: 'NavLink', Wordmark: 'Wordmark', Footer: 'Footer',
      setBilling: () => {},
    });
    const tree = Component({ session, billing: 'yearly' });
    const cards = nodes(tree).filter((node) => node.type === 'article');
    assert.equal(cards.length, 5);
    for (const [index, [tier, [, , monthly, yearly]]] of Object.entries(confirmedPrices).entries()) {
      const card = cards[index + 1];
      const prices = nodes(card).filter((node) => node.type === 'p' && node.props.className?.startsWith('pricing-price'));
      assert.deepEqual(prices.map((node) => text(node).replace(/\s+(?=\/)/g, '')), [`${yearly}/year`, `${monthly}/month`], tier);
      assert.ok(text(card).includes(`${confirmedWeeklyDays[tier]} campaign content-planning days per week`), tier);
      const checkout = nodes(card).find((node) => node.type === 'CheckoutButton');
      assert.deepEqual(checkout.props, { tier, billing: 'yearly', session });
    }
    assert.ok(text(tree).includes('Australian dollars (AUD)'));
  });
}

test('Account shows both catalog intervals and the subscription status without assuming monthly renewal', async () => {
  const start = accountSource.indexOf('const TIER_DETAILS');
  const end = accountSource.indexOf('function UpgradeOptions(');
  const Badge = await compile(accountSource.slice(start, end), 'TierBadge', { PLAN_ENTITLEMENTS, formatPlanPrice });
  for (const [tier, [, , monthly, yearly]] of Object.entries(confirmedPrices)) {
    const output = text(Badge({ tier, subscription: { status: 'past_due' } }));
    assert.ok(output.includes(`${monthly}/month`));
    assert.ok(output.includes(`${yearly}/year`));
    assert.ok(output.includes('Plan prices'));
    assert.ok(output.includes('past due'));
    assert.ok(output.includes(`${confirmedWeeklyDays[tier]} campaign content-planning days per week`), tier);
  }
});

async function checkoutHarness(redirectToCheckout, props = {}) {
  const state = hooks();
  const source = checkoutSource.replace(/^import .*;\r?\n/gm, '').replace('export default function', 'function');
  const Component = await compile(source, 'CheckoutButton', {
    useState: state.useState, useRef: state.useRef, NavLink: 'NavLink', redirectToCheckout, getPlanSelectionQuery,
  });
  let tree;
  const render = () => { state.reset(); tree = Component({ tier: 'growth', billing: 'yearly', session: { access_token: 'owner-test-token' }, ...props }); return tree; };
  render();
  return { render, nodes: () => nodes(tree), text: () => text(tree), button: () => nodes(tree).find((node) => node.type === 'button') };
}

test('signed-out checkout retains the selected plan at signup and does not call Stripe', async () => {
  let calls = 0;
  const ui = await checkoutHarness(async () => { calls += 1; }, { session: null });
  assert.equal(ui.nodes()[0].type, 'NavLink');
  assert.equal(ui.nodes()[0].props.to, '/signup?plan=growth&billing=yearly');
  assert.equal(calls, 0);
});

test('checkout submits the signed-in token and exact selection once, retaining busy state during redirect', async () => {
  const calls = [];
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const ui = await checkoutHarness((...args) => { calls.push(args); return pending; });
  const click = ui.button().props.onClick;
  const first = click();
  await click();
  ui.render();
  assert.equal(ui.button().props.disabled, true);
  assert.equal(ui.button().props['aria-busy'], true);
  assert.deepEqual(calls, [['growth', 'yearly', { accessToken: 'owner-test-token' }]]);
  resolve();
  await first;
  ui.render();
  assert.equal(ui.button().props.disabled, true, 'successful redirect cannot be submitted again');
});

test('checkout failure is visible and allows an explicit retry', async () => {
  let calls = 0;
  const ui = await checkoutHarness(async () => { calls += 1; throw new Error('Checkout is temporarily unavailable. Please try again shortly.'); });
  await ui.button().props.onClick();
  ui.render();
  assert.equal(ui.button().props.disabled, false);
  assert.ok(ui.nodes().find((node) => node.props.role === 'alert'));
  assert.match(ui.text(), /Checkout is temporarily unavailable/);
  await ui.button().props.onClick();
  assert.equal(calls, 2);
});

test('sign-in continuation keeps a chosen plan but gives existing purchase verification priority', () => {
  const auth = appSource.slice(appSource.indexOf('function AuthPage('), appSource.indexOf('function SignupSuccessPage('));
  const selection = auth.slice(auth.indexOf('const selectedPlan ='), auth.indexOf('const [mode,'));
  const destination = new Function('location', 'getPlanSelection', 'getPlanSelectionQuery', 'purchaseReturnPath', `${selection}; return loginDestination;`);
  const route = (search) => destination({ search }, getPlanSelection, getPlanSelectionQuery, purchaseReturnPath);
  assert.equal(route('?plan=growth&billing=yearly'), '/pricing?plan=growth&billing=yearly');
  assert.equal(route('?plan=growth&billing=yearly&purchase_session_id=cs_live_paid123'), '/purchase-success?session_id=cs_live_paid123');
  assert.equal(route('?plan=unknown&returnTo=https://example.test'), '/dashboard');
});

test('immediate signup preserves selected plan for review while the existing email redirect stays fixed', async () => {
  const source = appSource.slice(appSource.indexOf('function AuthPage('), appSource.indexOf('function SignupSuccessPage('));
  const calls = [];
  const state = hooks();
  const Component = await compile(source, 'AuthPage', {
    useState: state.useState, useEffect: () => {},
    useNavigate: () => (...args) => calls.push(['navigate', ...args]),
    useLocation: () => ({ search: '?plan=growth&billing=yearly' }),
    window: { location: { origin: 'https://dovroyn.com', hash: '' } },
    getPlanSelection, getPlanSelectionQuery, purchaseReturnPath,
    supabaseConfigured: true,
    supabase: { auth: { signUp: async (options) => { calls.push(['signup', options]); return { data: { session: { user: { id: 'new-owner' } } } }; } } },
    rememberSignupConversion: () => {}, trackConfirmedSignup: () => {}, Wordmark: 'Wordmark',
  });
  const tree = Component({ session: null, defaultMode: 'signup' });
  await nodes(tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls[0][1].options.emailRedirectTo, 'https://dovroyn.com/signup-success');
  assert.deepEqual(calls[1], ['navigate', '/signup-success?plan=growth&billing=yearly', { replace: true }]);
  const success = await compile(appSource.slice(appSource.indexOf('function SignupSuccessPage('), appSource.indexOf('function PurchaseSuccessPage(')), 'SignupSuccessPage', {
    useLocation: () => ({ search: '?plan=growth&billing=yearly' }), useEffect: () => {},
    getPlanSelection, getPlanSelectionQuery, Wordmark: 'Wordmark', CheckCircle: 'CheckCircle', Link: 'Link',
  });
  const continuation = nodes(success({ session: { user: { id: 'new-owner' } } })).find((node) => node.type === 'Link');
  assert.equal(continuation.props.to, '/pricing?plan=growth&billing=yearly');
  assert.equal(text(continuation), 'Review selected plan');
});
