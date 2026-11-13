import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { getBearerToken, readJsonBody, requirePost, sendJson } from '../_lib/http.js';
import { checkRateLimit } from '../_lib/rateLimit.js';
import { verifySupabaseUser, loadSubscriptionPaymentIdentity } from '../_lib/supabaseAuth.js';
import { BILLING_ORIGIN, CHECKOUT_SOURCE, billingPlan, resolveCheckoutPrice } from '../_lib/stripeBilling.js';

function checkoutUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://checkout.stripe.com' || !url.pathname.startsWith('/c/pay/')) throw new Error('Invalid checkout redirect.');
  return url.href;
}

async function checkoutCustomer(stripe, identity, user) {
  if (identity?.stripe_customer_id) {
    const customer = await stripe.customers.retrieve(identity.stripe_customer_id);
    if (customer.deleted || (customer.metadata?.dovroyn_user_id && customer.metadata.dovroyn_user_id !== user.id)) throw new Error('Payment identity is invalid.');
    return customer.id;
  }
  const found = await stripe.customers.search({ query: `metadata['dovroyn_user_id']:'${user.id}'`, limit: 2 });
  if (found.has_more || found.data?.length > 1) throw new Error('Payment identity needs review.');
  if (found.data?.length === 1) return found.data[0].id;
  // Concurrent first checkouts get the same customer, including during Search indexing delay.
  const customer = await stripe.customers.create({ email: user.email, metadata: { dovroyn_user_id: user.id } },
    { idempotencyKey: `dovroyn-customer-${user.id}` });
  return customer.id;
}

export function createCheckoutHandler({
  env = process.env, verifyUser = verifySupabaseUser, loadIdentity = loadSubscriptionPaymentIdentity,
  rateLimit = checkRateLimit, createStripe = (key) => new Stripe(key), resolvePrice = resolveCheckoutPrice,
} = {}) {
  return async function handler(req, res) {
    if (!requirePost(req, res)) return;
    const token = getBearerToken(req);
    if (!token) return sendJson(res, 401, { error: 'Sign in before subscribing.' });
    try {
      const user = await verifyUser(token);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user?.id || '') || !user.email) return sendJson(res, 401, { error: 'Sign in before subscribing.' });
      let body;
      try { body = readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Choose a valid plan and billing interval.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => !['tier', 'billing'].includes(key))
        || !billingPlan(body.tier, body.billing)) return sendJson(res, 400, { error: 'Choose a valid plan and billing interval.' });
      if (!rateLimit(`checkout:${user.id}`, { limit: 6, windowMs: 60000 }).allowed) {
        return sendJson(res, 429, { error: 'Please wait a minute before trying checkout again.' });
      }
      // Never take payment while the server cannot activate the corresponding account.
      if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY
        || !(env.VITE_SUPABASE_URL || env.SUPABASE_URL)) {
        return sendJson(res, 503, { error: 'Checkout is unavailable while payment activation is being configured.' });
      }
      const stripe = createStripe(env.STRIPE_SECRET_KEY);
      const identity = await loadIdentity(token, user.id);
      if (identity?.stripe_subscription_id) {
        const current = await stripe.subscriptions.retrieve(identity.stripe_subscription_id);
        if (!['canceled', 'incomplete_expired'].includes(current.status)) {
          return sendJson(res, 409, { error: 'You already have a subscription. Contact support@dovroyn.com to change it without starting a second subscription.' });
        }
      }
      const { link, price } = await resolvePrice(stripe, env, body.tier, body.billing);
      const customerId = await checkoutCustomer(stripe, identity, user);
      // The webhook may still be in flight; inspect Stripe itself before taking another payment.
      const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      if (subscriptions.has_more) throw new Error('Subscription history needs review.');
      if (subscriptions.data.some((item) => !['canceled', 'incomplete_expired'].includes(item.status))) {
        return sendJson(res, 409, { error: 'You already have a subscription. Contact support@dovroyn.com to change it without starting a second subscription.' });
      }
      const history = await stripe.checkout.sessions.list({ customer: customerId, limit: 100 });
      if (history.has_more) throw new Error('Checkout history needs review.');
      const pending = history.data.filter((session) => session.status === 'open');
      for (const session of pending) {
        if (session.metadata?.source !== CHECKOUT_SOURCE || session.metadata?.user_id !== user.id) throw new Error('An existing checkout needs review.');
        if (pending.length === 1 && session.metadata.tier === body.tier && session.metadata.billing === body.billing && session.metadata.price_id === price.id) {
          return sendJson(res, 200, { url: checkoutUrl(session.url) });
        }
        // Expiring the previous session prevents both old and new plan checkouts being paid.
        // If it completed concurrently, Stripe rejects expiry and no replacement is created.
        await stripe.checkout.sessions.expire(session.id);
      }
      const metadata = { source: CHECKOUT_SOURCE, user_id: user.id, tier: body.tier, billing: body.billing, price_id: price.id };
      const params = {
        mode: 'subscription', line_items: [{ price: price.id, quantity: 1 }],
        client_reference_id: user.id, metadata, subscription_data: { metadata },
        customer: customerId,
        success_url: `${BILLING_ORIGIN}/purchase-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BILLING_ORIGIN}/pricing?plan=${body.tier}&billing=${body.billing}`,
        automatic_tax: { enabled: link.automatic_tax?.enabled === true },
        ...(link.billing_address_collection ? { billing_address_collection: link.billing_address_collection } : {}),
        ...(link.tax_id_collection ? { tax_id_collection: { enabled: link.tax_id_collection.enabled === true } } : {}),
        ...(link.phone_number_collection ? { phone_number_collection: { enabled: link.phone_number_collection.enabled === true } } : {}),
        ...(Array.isArray(link.payment_method_types) && link.payment_method_types.length ? { payment_method_types: link.payment_method_types } : {}),
        allow_promotion_codes: link.allow_promotion_codes === true,
      };
      if (link.subscription_data?.trial_period_days) params.subscription_data.trial_period_days = link.subscription_data.trial_period_days;
      if (link.subscription_data?.trial_settings) params.subscription_data.trial_settings = link.subscription_data.trial_settings;
      if (link.subscription_data?.default_tax_rates?.length) params.subscription_data.default_tax_rates = link.subscription_data.default_tax_rates.map((rate) => typeof rate === 'string' ? rate : rate.id);
      if (link.automatic_tax?.enabled) params.customer_update = { address: 'auto' };
      // Stripe lists newest first. Advance only after a real prior session, never
      // a time boundary; concurrent plan choices share the same generation key.
      const attempt = createHash('sha256').update(`${user.id}:${history.data[0]?.id || 'initial'}`).digest('hex');
      const checkout = await stripe.checkout.sessions.create(params, { idempotencyKey: `dovroyn-checkout-${attempt}` });
      if (checkout.status !== 'open') throw new Error('Checkout is no longer open.');
      return sendJson(res, 200, { url: checkoutUrl(checkout.url) });
    } catch {
      return sendJson(res, 503, { error: 'Checkout is unavailable. Please try again or contact support@dovroyn.com.' });
    }
  };
}

export default createCheckoutHandler();
