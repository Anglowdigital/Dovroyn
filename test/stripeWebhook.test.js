import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import {
  createStripeWebhookHandler, findUserByEmail, normalizeSubscriptionStatus, readRawBody,
} from '../api/stripe/webhook.js';

const env = {
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_SECRET_KEY: 'sk_test',
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
};

function response() {
  const result = { headers: {} };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    status(value) { result.status = value; return res; },
    json(value) { result.body = value; return value; },
  };
  return { res, result };
}

function request(raw = '{"id": "evt_test"}') {
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { 'stripe-signature': 'valid-signature' };
  Object.defineProperty(req, 'body', { get() { throw new Error('parsed body must not be accessed'); } });
  return req;
}

function adminHarness({ pages = { 1: [{ id: 'user-1', email: 'owner@example.test' }] }, existing = null } = {}) {
  const writes = [];
  const listCalls = [];
  const admin = {
    auth: { admin: { async listUsers({ page, perPage }) {
      listCalls.push({ page, perPage });
      const value = pages[page] || [];
      if (value instanceof Error) return { data: { users: [] }, error: value };
      return { data: { users: value, nextPage: pages[page + 1] ? page + 1 : null }, error: null };
    } } },
    from(table) {
      assert.equal(table, 'subscriptions');
      const builder = {
        action: 'select',
        select() { return builder; },
        eq(field, value) {
          assert.equal(field, 'user_id');
          if (builder.action === 'update') {
            writes.push({ operation: 'update', userId: value, row: builder.row });
            return Promise.resolve({ error: null });
          }
          return builder;
        },
        async maybeSingle() { return { data: existing, error: null }; },
        update(row) { builder.action = 'update'; builder.row = row; return builder; },
        async insert(row) { writes.push({ operation: 'insert', row }); return { error: null }; },
      };
      return builder;
    },
  };
  return { admin, writes, listCalls };
}

function stripeHarness(event, overrides = {}) {
  const calls = [];
  const stripe = {
    webhooks: { constructEvent(raw, signature, secret) {
      calls.push(['signature', Buffer.from(raw).toString('utf8'), signature, secret]);
      return event;
    } },
    checkout: { sessions: { async retrieve(id, options) {
      calls.push(['checkout', id, options]);
      return {
        id,
        mode: 'subscription',
        customer: 'cus_owned',
        subscription: 'sub_owned',
        customer_details: { email: 'OWNER@example.test' },
        line_items: { data: [{ description: 'Dovroyn Starter' }] },
      };
    } } },
    subscriptions: { async retrieve(id) {
      calls.push(['subscription', id]);
      return { id, customer: 'cus_owned', status: 'active', current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 };
    } },
    customers: { async retrieve(id) {
      calls.push(['customer', id]);
      return { id, email: 'owner@example.test' };
    } },
    products: { async retrieve(id) {
      calls.push(['product', id]);
      return { id, name: 'Dovroyn Growth' };
    } },
    ...overrides,
  };
  return { stripe, calls };
}

test('Supabase user lookup uses the supported paginated listUsers API and exact normalized email', async () => {
  const fullPage = Array.from({ length: 1000 }, (_, index) => ({ id: `other-${index}`, email: `other-${index}@example.test` }));
  const listCalls = [];
  const admin = { auth: { admin: { async listUsers({ page, perPage }) {
    listCalls.push({ page, perPage });
    return { data: {
      users: page === 10 ? [{ id: 'wanted', email: 'Owner@Example.Test' }] : fullPage,
      // Reproduce the installed SDK's truncated multi-digit link parsing.
      nextPage: 1,
    }, error: null };
  } } } };
  assert.deepEqual(await findUserByEmail(admin, ' owner@example.test '), { id: 'wanted', email: 'Owner@Example.Test' });
  assert.deepEqual(listCalls.map((call) => call.page), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(listCalls.every((call) => call.perPage === 1000));
  const failed = adminHarness({ pages: { 1: new Error('admin denied') } });
  await assert.rejects(findUserByEmail(failed.admin, 'owner@example.test'), /admin denied/);
});

test('checkout webhook verifies exact raw bytes and stores trusted Stripe payment identity', async () => {
  const raw = '{\n  "id": "evt_checkout"\n}';
  const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_live_paid', mode: 'subscription' } } };
  const { stripe, calls } = stripeHarness(event);
  const { admin, writes } = adminHarness({ existing: { user_id: 'user-1', subscription_started_at: '2026-01-01T00:00:00.000Z' } });
  const handler = createStripeWebhookHandler({
    env,
    createStripe: (key) => { assert.equal(key, 'sk_test'); return stripe; },
    createAdmin: (url, key) => { assert.equal(url, env.VITE_SUPABASE_URL); assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY); return admin; },
    clock: () => '2026-10-11T00:00:00.000Z',
  });
  const { res, result } = response();
  await handler(request(raw), res);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { received: true, tier: 'starter' });
  assert.deepEqual(calls[0], ['signature', raw, 'valid-signature', 'whsec_test']);
  assert.deepEqual(calls.slice(1), [
    ['checkout', 'cs_live_paid', { expand: ['line_items'] }],
    ['subscription', 'sub_owned'],
  ]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].operation, 'update');
  assert.equal(writes[0].row.stripe_customer_id, 'cus_owned');
  assert.equal(writes[0].row.stripe_subscription_id, 'sub_owned');
  assert.equal(writes[0].row.max_pods, 1);
  assert.equal(writes[0].row.monthly_content_days, 10);
  assert.equal(writes[0].row.subscription_started_at, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /user-1|cus_owned|sub_owned/);
});

test('subscription updates and deletions preserve Stripe IDs and normalized status', async () => {
  for (const [type, expectedStatus] of [
    ['customer.subscription.updated', 'active'],
    ['customer.subscription.deleted', 'cancelled'],
  ]) {
    const subscription = {
      id: 'sub_owned',
      customer: { id: 'cus_owned' },
      status: 'active',
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_592_000,
      items: { data: [{ price: { nickname: null, product: { id: 'prod_growth' } } }] },
    };
    const event = { type, data: { object: subscription } };
    const { stripe } = stripeHarness(event);
    const { admin, writes } = adminHarness();
    const handler = createStripeWebhookHandler({ env, createStripe: () => stripe, createAdmin: () => admin });
    const { res, result } = response();
    await handler(request(), res);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, expectedStatus);
    assert.equal(writes[0].operation, 'insert');
    assert.equal(writes[0].row.tier, 'growth');
    assert.equal(writes[0].row.stripe_customer_id, 'cus_owned');
    assert.equal(writes[0].row.stripe_subscription_id, 'sub_owned');
    assert.equal(writes[0].row.status, expectedStatus);
  }
  assert.equal(normalizeSubscriptionStatus('incomplete_expired'), 'inactive');
});

test('an older subscription event cannot overwrite the currently stored subscription', async () => {
  const subscription = {
    id: 'sub_old',
    customer: 'cus_owned',
    status: 'canceled',
    current_period_start: 1_600_000_000,
    current_period_end: 1_602_592_000,
    items: { data: [{ price: { nickname: 'Dovroyn Starter' } }] },
  };
  const event = { type: 'customer.subscription.deleted', data: { object: subscription } };
  const { stripe } = stripeHarness(event);
  const { admin, writes } = adminHarness({ existing: {
    user_id: 'user-1',
    subscription_started_at: '2026-01-01T00:00:00.000Z',
    stripe_subscription_id: 'sub_current_growth',
  } });
  const handler = createStripeWebhookHandler({ env, createStripe: () => stripe, createAdmin: () => admin });
  const { res, result } = response();
  await handler(request(), res);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { received: true, ignored: 'different_subscription' });
  assert.deepEqual(writes, []);
});

test('invalid signatures, missing users and provider errors fail closed without leaking details', async () => {
  const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_live_paid', mode: 'subscription' } } };
  let adminCreated = false;
  const badSignature = createStripeWebhookHandler({
    env,
    createStripe: () => ({ webhooks: { constructEvent() { throw new Error('secret signature detail'); } } }),
    createAdmin: () => { adminCreated = true; },
  });
  let output = response();
  await badSignature(request(), output.res);
  assert.equal(output.result.status, 400);
  assert.equal(adminCreated, false);
  assert.doesNotMatch(JSON.stringify(output.result.body), /secret|detail/);

  const { stripe } = stripeHarness(event);
  const absent = adminHarness({ pages: { 1: [] } });
  const missingUser = createStripeWebhookHandler({ env, createStripe: () => stripe, createAdmin: () => absent.admin });
  output = response();
  await missingUser(request(), output.res);
  assert.deepEqual(output.result.body, { received: true, ignored: 'user_not_found' });
  assert.deepEqual(absent.writes, []);

  const broken = adminHarness();
  broken.admin.from = () => { throw new Error('service-role/raw-provider/customer detail'); };
  const providerFailure = createStripeWebhookHandler({ env, createStripe: () => stripe, createAdmin: () => broken.admin });
  output = response();
  await providerFailure(request(), output.res);
  assert.equal(output.result.status, 500);
  assert.deepEqual(output.result.body, { error: 'handler_failed' });
});

test('raw body reader returns byte-identical webhook payload', async () => {
  const raw = Buffer.from('{"unicode":"✓","spaces": [1, 2]}');
  const req = Readable.from([raw.subarray(0, 8), raw.subarray(8)]);
  assert.deepEqual(await readRawBody(req), raw);
});

test('real Stripe SDK accepts the streamed payload and generated signature unchanged', async () => {
  const stripe = new Stripe('sk_test_signature');
  const raw = '{"id":"evt_signed","type":"unhandled.test","data":{"object":{}}}';
  const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret: env.STRIPE_WEBHOOK_SECRET });
  const req = request(raw);
  req.headers['stripe-signature'] = signature;
  const { admin } = adminHarness();
  const handler = createStripeWebhookHandler({ env, createStripe: () => stripe, createAdmin: () => admin });
  const { res, result } = response();
  await handler(req, res);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { received: true, ignored: 'unhandled.test' });
});

test('paid Payment Links require the existing signed-in session without changing destinations', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const pricing = source.split('{PRICING_TIERS.map((tier) => (')[1].split('</section>')[0];
  assert.match(pricing, /session && tier\.stripeKey && STRIPE_PRICING_LINKS/);
  assert.match(pricing, /href=\{STRIPE_PRICING_LINKS\[`\$\{tier\.stripeKey\}_\$\{billing\}`\]\}/);
  assert.match(pricing, /!session \? \(\s*<NavLink className="button button-primary" to="\/signup">Create account<\/NavLink>/);
});
