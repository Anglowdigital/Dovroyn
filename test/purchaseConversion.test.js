import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerifyPurchaseHandler, verifiedPurchasePayload } from '../api/stripe/verify-purchase.js';
import { loadSubscriptionPaymentIdentity } from '../api/_lib/supabaseAuth.js';
import { trackVerifiedPurchase, verifyPurchase } from '../src/lib/purchaseConversion.js';

const identity = { stripe_customer_id: 'cus_owned', stripe_subscription_id: 'sub_owned', tier: 'starter' };
const checkout = {
  id: 'cs_live_paid123', customer: 'cus_owned', subscription: 'sub_owned', livemode: true,
  mode: 'subscription', status: 'complete', payment_status: 'paid', amount_total: 8900, currency: 'aud',
  customer_details: { email: 'must-not-leak@example.test' },
};
const purchase = verifiedPurchasePayload(checkout, identity);

function invoke(handler, body = { sessionId: checkout.id }, token = 'valid', method = 'POST') {
  const result = { headers: {} };
  const res = {
    setHeader(key, value) { result.headers[key] = value; },
    status(value) { result.status = value; return res; },
    json(value) { result.body = value; },
  };
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  return handler(req, res).then(() => result);
}

function harness(overrides = {}) {
  const calls = [];
  const handler = createVerifyPurchaseHandler({
    verifyUser: async (token) => token === 'valid' ? { id: 'owned-user' } : null,
    loadIdentity: async (token, userId) => { calls.push(['identity', token, userId]); return identity; },
    rateLimit: () => ({ allowed: true }),
    retrieveCheckout: async (id) => { calls.push(['stripe', id]); return checkout; },
    env: { STRIPE_SECRET_KEY: 'server-only-test-key' },
    ...overrides,
  });
  return { handler, calls };
}

test('verified initial AUD checkout uses paid amount, stable private transaction ID and no customer data', async () => {
  const { handler, calls } = harness();
  const result = await invoke(handler);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['currency', 'transaction_id', 'value', 'verified']);
  assert.equal(result.body.value, 89);
  assert.equal(result.body.currency, 'AUD');
  assert.match(result.body.transaction_id, /^[a-f0-9]{64}$/);
  assert.equal(result.body.transaction_id, verifiedPurchasePayload(checkout, identity).transaction_id);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls, [['identity', 'valid', 'owned-user'], ['stripe', checkout.id]]);
  assert.doesNotMatch(JSON.stringify(result.body), /cus_owned|sub_owned|cs_live_paid123|must-not-leak/);
});

test('unpaid, trial, incomplete, test, other-customer/subscription and unsupported-currency sessions never produce conversions', () => {
  for (const change of [
    { payment_status: 'unpaid' }, { payment_status: 'no_payment_required', amount_total: 0 },
    { amount_total: 0 }, { amount_total: -1 }, { amount_total: 1.5 },
    { status: 'open' }, { status: 'expired' }, { mode: 'payment' }, { mode: 'setup' },
    { livemode: false }, { currency: 'jpy' }, { customer: 'cus_someone_else' },
    { subscription: 'sub_someone_else' }, { subscription: null }, { id: 'cs_test_paid123' },
  ]) assert.equal(verifiedPurchasePayload({ ...checkout, ...change }, identity), null, JSON.stringify(change));
  assert.equal(verifiedPurchasePayload(checkout, {}), null);
  assert.equal(verifiedPurchasePayload(checkout, { ...identity, tier: 'free' }), null);
  const expanded = verifiedPurchasePayload({ ...checkout, customer: { id: 'cus_owned' }, subscription: { id: 'sub_owned' } }, identity);
  assert.deepEqual(expanded, purchase);
});

test('no auth, invalid auth, wrong method, bad reference and malformed JSON cannot retrieve payments', async () => {
  const { handler, calls } = harness();
  assert.equal((await invoke(handler, {}, null)).status, 401);
  assert.equal((await invoke(handler, {}, 'expired')).status, 401);
  assert.equal((await invoke(handler, {}, 'valid', 'GET')).status, 405);
  for (const body of ['{invalid', {}, { sessionId: ['cs_live_paid123'] }, { sessionId: 'cs_test_paid123' }, { sessionId: 'cs_live_' + 'a'.repeat(256) }]) {
    assert.equal((await invoke(handler, body)).status, 400);
  }
  assert.deepEqual(calls, []);
});

test('missing configuration/ownership and rate limit fail closed before Stripe lookup', async () => {
  for (const [override, expected] of [
    [{ env: {} }, 503], [{ loadIdentity: async () => null }, 404],
    [{ loadIdentity: async () => ({ ...identity, stripe_customer_id: null }) }, 404],
    [{ rateLimit: () => ({ allowed: false }) }, 429],
  ]) {
    const { handler, calls } = harness(override);
    assert.equal((await invoke(handler)).status, expected);
    assert.equal(calls.some((call) => call[0] === 'stripe'), false);
  }
});

test('wrong owner and unpaid results are not exposed; unexpected provider errors never leak', async () => {
  for (const retrieved of [{ ...checkout, customer: 'other' }, { ...checkout, payment_status: 'unpaid' }, { ...checkout, id: 'cs_live_other123' }]) {
    const { handler } = harness({ retrieveCheckout: async () => retrieved });
    const result = await invoke(handler);
    assert.equal(result.status, 404);
    assert.equal(result.body.verified, undefined);
    assert.equal(result.body.value, undefined);
  }
  const { handler } = harness({ retrieveCheckout: async () => { throw new Error('secret/customer/raw-provider-error'); } });
  const result = await invoke(handler);
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(result.body), /secret|customer|raw-provider-error/);
});

test('payment identity read uses existing user scope and bearer auth, with no service-key bypass', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.VITE_SUPABASE_URL;
  const previousKey = process.env.VITE_SUPABASE_ANON_KEY;
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'public-test-key';
  const calls = [];
  globalThis.fetch = async (...args) => { calls.push(args); return { ok: true, json: async () => [identity] }; };
  try {
    assert.deepEqual(await loadSubscriptionPaymentIdentity('user-token', 'owned-user'), identity);
    assert.equal(calls[0][0], 'https://example.supabase.co/rest/v1/subscriptions?user_id=eq.owned-user&select=stripe_customer_id,stripe_subscription_id,tier');
    assert.equal(calls[0][1].headers.Authorization, 'Bearer user-token');
    assert.equal(calls[0][1].headers.apikey, 'public-test-key');
    globalThis.fetch = async () => ({ ok: false });
    await assert.rejects(loadSubscriptionPaymentIdentity('user-token', 'owned-user'), /unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY; else process.env.VITE_SUPABASE_ANON_KEY = previousKey;
  }
});

function browser() {
  const calls = [];
  const stored = new Map();
  return { calls, gtag: (...args) => calls.push(args), localStorage: {
    getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value),
  } };
}

test('purchase event is wired to configured label, once across repeat effects and reload', () => {
  const target = browser();
  assert.equal(trackVerifiedPurchase(purchase, '', target), false);
  assert.equal(trackVerifiedPurchase(purchase, 'purchase-label', target), true);
  assert.equal(trackVerifiedPurchase(purchase, 'purchase-label', target), false);
  assert.equal(trackVerifiedPurchase(purchase, 'purchase-label', { ...target }), false);
  assert.deepEqual(target.calls, [['event', 'conversion', {
    value: 89, currency: 'AUD', transaction_id: purchase.transaction_id,
    send_to: 'AW-18371036038/purchase-label',
  }]]);
  const anotherPurchase = verifiedPurchasePayload({ ...checkout, id: 'cs_live_other123', amount_total: 24900 }, identity);
  assert.equal(trackVerifiedPurchase(anotherPurchase, 'purchase-label', target), true);
  assert.equal(target.calls[1][2].value, 249);
});

test('unverified client payloads and storage failures cannot manufacture conversions or crash the page', () => {
  const target = browser();
  for (const invalid of [{ ...purchase, verified: false }, { ...purchase, value: 0 }, { ...purchase, currency: 'JPY' }, { ...purchase, transaction_id: checkout.id }, {}]) {
    assert.equal(trackVerifiedPurchase(invalid, 'label', target), false);
  }
  assert.deepEqual(target.calls, []);
  Object.defineProperty(target, 'localStorage', { get() { throw new Error('blocked'); } });
  assert.equal(trackVerifiedPurchase(purchase, 'label', target), true);
  assert.equal(trackVerifiedPurchase(purchase, 'label', target), false);
});

test('browser requests server verification with bearer token and no client-provided amount', async () => {
  const calls = [];
  const result = await verifyPurchase(checkout.id, 'user-token', async (...args) => {
    calls.push(args); return { ok: true, json: async () => purchase };
  });
  assert.deepEqual(result, purchase);
  assert.equal(calls[0][0], '/api/stripe/verify-purchase');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer user-token');
  assert.deepEqual(JSON.parse(calls[0][1].body), { sessionId: checkout.id });
  for (const response of [{ ok: false, json: async () => ({ error: 'raw-secret' }) }, { ok: true, json: async () => ({ verified: false }) }]) {
    await assert.rejects(verifyPurchase(checkout.id, 'user-token', async () => response), /could not be confirmed/);
  }
});

test('purchase success route calls verification before tracking and does not alter checkout destinations', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /Route path="\/purchase-success" element={<PurchaseSuccessPage session={session} \/>} \/>/);
  const page = source.split('function PurchaseSuccessPage(')[1].split('/* ─── APP LAYOUT ─── */')[0];
  assert.ok(page.indexOf('verifyPurchase(sessionId, session.access_token)') < page.indexOf('trackVerifiedPurchase(purchase'));
  assert.match(page, /if \(cancelled\) return;/);
  assert.match(source, /href={STRIPE_PRICING_LINKS\[`\$\{tier\.stripeKey\}_\$\{billing\}`\]}/);
});

test('unmounted purchase page cannot emit a late conversion or show stale confirmation', async () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const page = source.split('function PurchaseSuccessPage(')[1].split('/* ─── APP LAYOUT ─── */')[0];
  const effect = page.split('useEffect(() => {')[1].split('}, [session?.access_token, sessionId, retry, scope])')[0];
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const stateUpdates = [];
  const conversions = [];
  const run = new Function('session', 'sessionId', 'scope', 'setPaymentState', 'verifyPurchase', 'trackVerifiedPurchase', 'window', effect);
  const cleanup = run({ access_token: 'token' }, checkout.id, 'user-a:checkout-a', (value) => stateUpdates.push(value), () => pending, (...args) => conversions.push(args), {});
  cleanup();
  resolve(purchase);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(conversions, []);
  assert.deepEqual(stateUpdates, [{ scope: 'user-a:checkout-a', status: 'checking', message: '' }]);
  assert.match(page, /paymentState\.scope === scope \? paymentState\.status : 'checking'/);
});
