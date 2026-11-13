import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { sendJson } from '../_lib/http.js';
import { billingPlan, priceMatchesPlan, resolveCheckoutPrice, singleBillingItem, subscriptionPeriod, trustedBillingMetadata } from '../_lib/stripeBilling.js';

const TIER_LIMITS = {
  starter: { maxPods: 1, monthlyContentDays: 10, weeklyPostingDays: 2 },
  growth: { maxPods: 3, monthlyContentDays: 20, weeklyPostingDays: 3 },
  pro: { maxPods: 7, monthlyContentDays: 30, weeklyPostingDays: 6 },
  scale: { maxPods: 12, monthlyContentDays: 30, weeklyPostingDays: 7 },
};

function objectId(value) {
  return typeof value === 'string' ? value : value?.id;
}

async function userFromBinding(admin, binding) {
  const { data, error } = await admin.auth.admin.getUserById(binding.user_id);
  if (error || !data?.user || data.user.id !== binding.user_id) throw new Error('Checkout account is unavailable.');
  return data.user;
}

function validateBoundSubscription(subscription, binding) {
  const own = trustedBillingMetadata(subscription);
  if (!own || ['user_id', 'tier', 'billing', 'price_id'].some((key) => own[key] !== binding[key])) throw new Error('Subscription binding does not match.');
  const item = singleBillingItem(subscription.items);
  if (!item || item.price?.id !== binding.price_id || !priceMatchesPlan(item.price, billingPlan(binding.tier, binding.billing))) {
    throw new Error('Subscription price does not match the approved plan.');
  }
}

function compareSubscriptionOrder(incoming, current) {
  if (!Number.isSafeInteger(incoming?.created) || !Number.isSafeInteger(current?.created)) return null;
  if (incoming.created !== current.created) return incoming.created > current.created ? 1 : -1;
  const incomingId = objectId(incoming);
  const currentId = objectId(current);
  if (!incomingId || !currentId) return null;
  if (incomingId === currentId) return 0;
  // Stripe creation times are whole seconds. IDs provide a stable tie-breaker so
  // concurrent same-second checkouts converge instead of replacing each other.
  return incomingId > currentId ? 1 : -1;
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
    let update = admin.from('subscriptions').update(row).eq('user_id', userId);
    update = existing.stripe_subscription_id
      ? update.eq('stripe_subscription_id', existing.stripe_subscription_id)
      : update.is('stripe_subscription_id', null);
    const { data, error } = await update.select('user_id');
    if (error) throw error;
    if (!data?.length) return 'ignored_concurrent_change';
  } else {
    const { error } = await admin.from('subscriptions').insert(row);
    if (error?.code === '23505') return 'ignored_concurrent_change';
    if (error) throw error;
  }
  return 'written';
}

export function createStripeWebhookHandler({
  env = process.env,
  createStripe = (key) => new Stripe(key),
  createAdmin = (url, key) => createClient(url, key, { auth: { persistSession: false } }),
  readBody = readRawBody,
  resolvePrice = resolveCheckoutPrice,
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
        const subscriptionId = objectId(expanded.subscription);
        const customerId = objectId(expanded.customer);
        if (!subscriptionId || !customerId) return sendJson(res, 200, { received: true, ignored: 'payment_identity_missing' });
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const binding = trustedBillingMetadata(expanded);
        let tier;
        let user;
        if (binding) {
          const item = singleBillingItem(expanded.line_items);
          if (expanded.client_reference_id !== binding.user_id || expanded.status !== 'complete'
            || !['paid', 'no_payment_required'].includes(expanded.payment_status)
            || !item || item.price?.id !== binding.price_id
            || !priceMatchesPlan(item.price, billingPlan(binding.tier, binding.billing))
            || objectId(subscription.customer) !== customerId) throw new Error('Checkout binding does not match.');
          validateBoundSubscription(subscription, binding);
          tier = binding.tier;
          user = await userFromBinding(admin, binding);
        } else {
          // Compatibility for previously issued Payment Links. Client reference IDs
          // on public links are user-controlled and must never establish ownership.
          if (trustedBillingMetadata(subscription)) throw new Error('Missing checkout account binding.');
          tier = resolveTier(line?.description || line?.price?.nickname || '');
          const email = expanded.customer_details?.email || expanded.customer_email;
          if (!tier || !email) return sendJson(res, 200, { received: true, ignored: 'unresolved_tier' });
          const item = singleBillingItem(expanded.line_items);
          const billing = item?.price?.recurring?.interval === 'month' ? 'monthly'
            : item?.price?.recurring?.interval === 'year' ? 'yearly' : null;
          if (!item || !billing || !objectId(expanded.payment_link) || expanded.status !== 'complete'
            || expanded.payment_status !== 'paid' || objectId(subscription.customer) !== customerId) {
            return sendJson(res, 200, { received: true, ignored: 'unverified_legacy_checkout' });
          }
          const configured = await resolvePrice(stripe, env, tier, billing);
          if (objectId(expanded.payment_link) !== configured.link.id || expanded.livemode !== configured.link.livemode
            || item.price.id !== configured.price.id || !priceMatchesPlan(item.price, billingPlan(tier, billing))) {
            return sendJson(res, 200, { received: true, ignored: 'unverified_legacy_checkout' });
          }
          user = await findUserByEmail(admin, email);
          if (!user) return sendJson(res, 200, { received: true, ignored: 'user_not_found' });
        }
        const period = subscriptionPeriod(subscription);
        let existing = await loadSubscriptionRow(admin, user.id);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let replaceDifferentSubscription = false;
          if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== subscriptionId) {
            const current = await stripe.subscriptions.retrieve(existing.stripe_subscription_id);
            const order = compareSubscriptionOrder(subscription, current);
            if (order === null) throw new Error('Stripe subscription ordering data is incomplete.');
            if (order <= 0) {
              return sendJson(res, 200, { received: true, ignored: 'stale_checkout' });
            }
            replaceDifferentSubscription = true;
          }
          const outcome = await upsertSubscription(admin, {
            userId: user.id,
            tier,
            status: normalizeSubscriptionStatus(subscription.status),
            ...period,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            replaceDifferentSubscription,
            existingRow: existing,
            now: clock(),
          });
          if (outcome !== 'ignored_concurrent_change') {
            return sendJson(res, 200, { received: true, tier });
          }
          // Another delivery changed the row after our read. Reconcile against it so
          // the newest checkout cannot be acknowledged and then lost permanently.
          existing = await loadSubscriptionRow(admin, user.id);
        }
        throw new Error('Subscription row kept changing during checkout reconciliation.');
      }

      if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const price = subscription.items?.data?.[0]?.price;
        const customerId = objectId(subscription.customer);
        const subscriptionId = objectId(subscription);
        const binding = trustedBillingMetadata(subscription);
        let tier;
        let user;
        let existingRow;
        if (binding) {
          validateBoundSubscription(subscription, binding);
          tier = binding.tier;
          user = await userFromBinding(admin, binding);
        } else {
          if (!customerId || !subscriptionId) return sendJson(res, 200, { received: true, ignored: 'unbound_subscription' });
          const { data, error } = await admin.from('subscriptions')
            .select('user_id,tier,subscription_started_at,stripe_subscription_id,stripe_customer_id')
            .eq('stripe_subscription_id', subscriptionId).eq('stripe_customer_id', customerId).maybeSingle();
          if (error) throw error;
          if (!data?.user_id || data.stripe_subscription_id !== subscriptionId || data.stripe_customer_id !== customerId) {
            return sendJson(res, 200, { received: true, ignored: 'unbound_subscription' });
          }
          // Old events may update only an identity already provisioned by our webhook.
          // Product names and customer-entered email cannot create or select an account.
          existingRow = data;
          tier = data.tier;
          user = { id: data.user_id };
          if (!Object.hasOwn(TIER_LIMITS, tier)) throw new Error('Stored subscription plan is invalid.');
          if (event.type !== 'customer.subscription.deleted' && ['active', 'trialing'].includes(subscription.status)) {
            const item = singleBillingItem(subscription.items);
            const billing = price?.recurring?.interval === 'month' ? 'monthly' : price?.recurring?.interval === 'year' ? 'yearly' : null;
            if (!item || !priceMatchesPlan(price, billingPlan(tier, billing))) throw new Error('Legacy subscription price changed.');
          }
        }
        if (!customerId || !subscriptionId) throw new Error('Missing payment identity.');
        const period = subscriptionPeriod(subscription);
        const status = normalizeSubscriptionStatus(event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status);
        const outcome = await upsertSubscription(admin, {
          userId: user.id,
          tier,
          status,
          ...period,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          existingRow,
          now: clock(),
        });
        if (outcome === 'ignored_different_subscription' || outcome === 'ignored_concurrent_change') {
          const ignored = outcome === 'ignored_different_subscription' ? 'different_subscription' : 'concurrent_change';
          return sendJson(res, 200, { received: true, ignored });
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
