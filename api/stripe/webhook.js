import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { sendJson } from '../_lib/http.js';

const TIER_LIMITS = {
  starter: { maxPods: 1, monthlyContentDays: 10, weeklyPostingDays: 2 },
  growth: { maxPods: 3, monthlyContentDays: 20, weeklyPostingDays: 3 },
  pro: { maxPods: 7, monthlyContentDays: 30, weeklyPostingDays: 6 },
  scale: { maxPods: 12, monthlyContentDays: 30, weeklyPostingDays: 7 },
};

function objectId(value) {
  return typeof value === 'string' ? value : value?.id;
}

// Stripe sends 'canceled'; the DB CHECK constraint only accepts 'cancelled'.
export function normalizeSubscriptionStatus(status) {
  if (status === 'canceled') return 'cancelled';
  if (status === 'incomplete' || status === 'incomplete_expired') return 'inactive';
  return status;
}

export function resolveTier(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('scale') || n.includes('agency')) return 'scale';
  if (n.includes('growth')) return 'growth';
  if (n.includes('pro')) return 'pro';
  if (n.includes('starter') || n.includes('start')) return 'starter';
  return null;
}

export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function findUserByEmail(admin, email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  const perPage = 1000;
  let page = 1;
  for (let request = 0; request < 100; request += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    const match = users.find((user) => String(user.email || '').trim().toLowerCase() === wanted);
    if (match) return match;
    if (users.length < perPage) return null;
    // The installed SDK truncates multi-digit nextPage link values. Advance locally.
    page += 1;
  }
  throw new Error('Supabase user lookup exceeded its pagination limit.');
}

export async function loadSubscriptionRow(admin, userId) {
  const { data, error } = await admin.from('subscriptions')
    .select('user_id,subscription_started_at,stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertSubscription(admin, {
  userId, tier, status, periodEnd, periodStart, stripeCustomerId, stripeSubscriptionId,
  replaceDifferentSubscription = false, existingRow, now = new Date().toISOString(),
}) {
  if (!stripeCustomerId || !stripeSubscriptionId) throw new Error('Stripe payment identity is incomplete.');
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.starter;
  const active = status === 'active' || status === 'trialing';
  const row = {
    user_id: userId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    tier,
    status: active ? 'active' : status,
    max_pods: active ? limits.maxPods : 0,
    monthly_content_days: active ? limits.monthlyContentDays : 0,
    weekly_posting_days: limits.weeklyPostingDays,
    subscription_started_at: now,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
  };
  const existing = existingRow === undefined ? await loadSubscriptionRow(admin, userId) : existingRow;
  if (existing) {
    if (existing.stripe_subscription_id && existing.stripe_subscription_id !== stripeSubscriptionId && !replaceDifferentSubscription) {
      return 'ignored_different_subscription';
    }
    if (existing.subscription_started_at) delete row.subscription_started_at;
    const { error } = await admin.from('subscriptions').update(row).eq('user_id', userId);
    if (error) throw error;
  } else {
    const { error } = await admin.from('subscriptions').insert(row);
    if (error) throw error;
  }
}

export function createStripeWebhookHandler({
  env = process.env,
  createStripe = (key) => new Stripe(key),
  createAdmin = (url, key) => createClient(url, key, { auth: { persistSession: false } }),
  readBody = readRawBody,
  clock = () => new Date().toISOString(),
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    const secretKey = env.STRIPE_SECRET_KEY;
    if (!webhookSecret || !secretKey) return sendJson(res, 500, { error: 'stripe_not_configured' });

    const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'supabase_admin_not_configured' });

    const stripe = createStripe(secretKey);
    let event;
    try {
      // Stripe signatures cover the exact bytes. Never reconstruct a parsed JSON body.
      const rawBody = await readBody(req);
      event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], webhookSecret);
    } catch {
      return sendJson(res, 400, { error: 'signature_verification_failed' });
    }

    const admin = createAdmin(supabaseUrl, serviceKey);
    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        if (session.mode !== 'subscription') return sendJson(res, 200, { received: true, ignored: 'not_subscription' });
        const expanded = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
        const line = expanded.line_items?.data?.[0];
        const tier = resolveTier(line?.description || line?.price?.nickname || '');
        const email = expanded.customer_details?.email || expanded.customer_email;
        if (!tier || !email) return sendJson(res, 200, { received: true, ignored: 'unresolved_tier' });
        const user = await findUserByEmail(admin, email);
        if (!user) return sendJson(res, 200, { received: true, ignored: 'user_not_found' });
        const subscriptionId = objectId(expanded.subscription);
        const customerId = objectId(expanded.customer);
        if (!subscriptionId || !customerId) return sendJson(res, 200, { received: true, ignored: 'payment_identity_missing' });
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const existing = await loadSubscriptionRow(admin, user.id);
        let replaceDifferentSubscription = false;
        if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== subscriptionId) {
          const current = await stripe.subscriptions.retrieve(existing.stripe_subscription_id);
          if (!Number.isSafeInteger(subscription.created) || !Number.isSafeInteger(current?.created)
            || subscription.created <= current.created) {
            return sendJson(res, 200, { received: true, ignored: 'stale_checkout' });
          }
          replaceDifferentSubscription = true;
        }
        await upsertSubscription(admin, {
          userId: user.id,
          tier,
          status: normalizeSubscriptionStatus(subscription.status),
          periodEnd: subscription.current_period_end,
          periodStart: subscription.current_period_start,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          replaceDifferentSubscription,
          existingRow: existing,
          now: clock(),
        });
        return sendJson(res, 200, { received: true, tier });
      }

      if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const price = subscription.items?.data?.[0]?.price;
        let tier = resolveTier(price?.nickname || '');
        if (!tier && price?.product) {
          const product = await stripe.products.retrieve(objectId(price.product));
          tier = resolveTier(product?.name || '');
        }
        const customerId = objectId(subscription.customer);
        const subscriptionId = objectId(subscription);
        const customer = customerId ? await stripe.customers.retrieve(customerId) : null;
        const email = customer?.deleted ? null : customer?.email;
        if (!tier || !email || !customerId || !subscriptionId) return sendJson(res, 200, { received: true, ignored: 'unresolved' });
        const user = await findUserByEmail(admin, email);
        if (!user) return sendJson(res, 200, { received: true, ignored: 'user_not_found' });
        const status = normalizeSubscriptionStatus(event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status);
        const outcome = await upsertSubscription(admin, {
          userId: user.id,
          tier,
          status,
          periodEnd: subscription.current_period_end,
          periodStart: subscription.current_period_start,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          now: clock(),
        });
        if (outcome === 'ignored_different_subscription') {
          return sendJson(res, 200, { received: true, ignored: 'different_subscription' });
        }
        return sendJson(res, 200, { received: true, tier, status });
      }

      return sendJson(res, 200, { received: true, ignored: event.type });
    } catch {
      // Stripe, Supabase, customer and secret details must not leak to webhook callers.
      return sendJson(res, 500, { error: 'handler_failed' });
    }
  };
}

export default createStripeWebhookHandler();
