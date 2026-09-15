import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { sendJson } from '../_lib/http.js';

const TIER_LIMITS = {
  starter: { maxPods: 1, monthlyContentDays: 10 },
  growth: { maxPods: 3, monthlyContentDays: 20 },
  pro: { maxPods: 7, monthlyContentDays: 30 },
  scale: { maxPods: 12, monthlyContentDays: 30 },
};

function resolveTier(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('scale') || n.includes('agency')) return 'scale';
  if (n.includes('growth')) return 'growth';
  if (n.includes('pro')) return 'pro';
  if (n.includes('starter') || n.includes('start')) return 'starter';
  return null;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function upsertSubscription(admin, userId, tier, status, periodEnd) {
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.starter;
  const active = status === 'active' || status === 'trialing';
  const row = {
    user_id: userId,
    tier,
    status: active ? 'active' : status,
    max_pods: active ? limits.maxPods : 0,
    monthly_content_days: active ? limits.monthlyContentDays : 0,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
  const { data: existing } = await admin.from('subscriptions').select('user_id').eq('user_id', userId).maybeSingle();
  if (existing) {
    const { error } = await admin.from('subscriptions').update(row).eq('user_id', userId);
    if (error) throw error;
  } else {
    const { error } = await admin.from('subscriptions').insert(row);
    if (error) throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!webhookSecret || !secretKey) return sendJson(res, 500, { error: 'stripe_not_configured' });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'supabase_admin_not_configured' });

  const stripe = new Stripe(secretKey);
  let event;
  try {
    const rawBody = typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body) : await readRawBody(req));
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch {
    return sendJson(res, 400, { error: 'signature_verification_failed' });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode !== 'subscription') return sendJson(res, 200, { received: true, ignored: 'not_subscription' });
      const expanded = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
      const line = expanded.line_items?.data?.[0];
      const tier = resolveTier(line?.description || line?.price?.nickname || '');
      const email = session.customer_details?.email || session.customer_email;
      if (!tier || !email) return sendJson(res, 200, { received: true, ignored: 'unresolved_tier' });
      const { data: userData } = await admin.auth.admin.getUserByEmail(email);
      if (!userData?.user) return sendJson(res, 200, { received: true, ignored: 'user_not_found' });
      const subscription = await stripe.subscriptions.retrieve(String(session.subscription));
      await upsertSubscription(admin, userData.user.id, tier, subscription.status, subscription.current_period_end);
      return sendJson(res, 200, { received: true, tier, user: userData.user.id });
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const price = subscription.items?.data?.[0]?.price;
      let tier = resolveTier(price?.nickname || '');
      if (!tier && price?.product) {
        const product = await stripe.products.retrieve(String(price.product));
        tier = resolveTier(product?.name || '');
      }
      const customer = await stripe.customers.retrieve(String(subscription.customer));
      const email = customer?.email;
      if (!tier || !email) return sendJson(res, 200, { received: true, ignored: 'unresolved' });
      const { data: userData } = await admin.auth.admin.getUserByEmail(email);
      if (!userData?.user) return sendJson(res, 200, { received: true, ignored: 'user_not_found' });
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status;
      await upsertSubscription(admin, userData.user.id, tier, status, subscription.current_period_end);
      return sendJson(res, 200, { received: true, tier, status });
    }

    return sendJson(res, 200, { received: true, ignored: event.type });
  } catch (err) {
    return sendJson(res, 500, { error: 'handler_failed', detail: String(err?.message || err) });
  }
}
