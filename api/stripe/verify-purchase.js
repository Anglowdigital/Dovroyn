import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { getBearerToken, readJsonBody, requirePost, sendJson } from '../_lib/http.js';
import { checkRateLimit } from '../_lib/rateLimit.js';
import { loadSubscriptionPaymentIdentity, verifySupabaseUser } from '../_lib/supabaseAuth.js';

function objectId(value) {
  return typeof value === 'string' ? value : value?.id;
}

export function verifiedPurchasePayload(checkout, identity) {
  if (!identity?.stripe_customer_id || !identity?.stripe_subscription_id) return null;
  if (!['starter', 'growth', 'pro', 'scale'].includes(identity.tier)) return null;
  if (objectId(checkout?.customer) !== identity.stripe_customer_id
    || objectId(checkout?.subscription) !== identity.stripe_subscription_id) return null;
  if (checkout?.livemode !== true || checkout.mode !== 'subscription'
    || checkout.status !== 'complete' || checkout.payment_status !== 'paid') return null;
  // Dovroyn's current measurement uses AUD. Do not guess currency units.
  if (checkout.currency !== 'aud' || !Number.isSafeInteger(checkout.amount_total)
    || checkout.amount_total <= 0 || !/^cs_live_[A-Za-z0-9]+$/.test(checkout.id || '')) return null;
  return {
    verified: true,
    value: checkout.amount_total / 100,
    currency: 'AUD',
    transaction_id: createHash('sha256').update(checkout.id).digest('hex'),
  };
}

export function createVerifyPurchaseHandler({
  verifyUser = verifySupabaseUser,
  loadIdentity = loadSubscriptionPaymentIdentity,
  rateLimit = checkRateLimit,
  retrieveCheckout = (id, key) => new Stripe(key).checkout.sessions.retrieve(id),
  env = process.env,
} = {}) {
  return async function handler(req, res) {
    if (!requirePost(req, res)) return;
    const token = getBearerToken(req);
    if (!token) return sendJson(res, 401, { error: 'Sign in to verify your payment.' });
    try {
      const user = await verifyUser(token);
      if (!user?.id) return sendJson(res, 401, { error: 'Sign in to verify your payment.' });
      if (!rateLimit(`purchase-verification:${user.id}`, { limit: 20, windowMs: 60000 }).allowed) {
        return sendJson(res, 429, { error: 'Please wait before checking again.' });
      }
      let body;
      try { body = readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid payment reference.' }); }
      const id = body?.sessionId;
      if (typeof id !== 'string' || id.length > 255 || !/^cs_live_[A-Za-z0-9]+$/.test(id)) {
        return sendJson(res, 400, { error: 'Invalid payment reference.' });
      }
      if (!env.STRIPE_SECRET_KEY) return sendJson(res, 503, { error: 'Payment verification is unavailable.' });
      const identity = await loadIdentity(token, user.id);
      // Never fall back to customer-entered email or client-supplied account IDs.
      if (!identity?.stripe_customer_id || !identity?.stripe_subscription_id) {
        return sendJson(res, 404, { error: 'Payment could not be confirmed yet.' });
      }
      const checkout = await retrieveCheckout(id, env.STRIPE_SECRET_KEY);
      const purchase = checkout?.id === id ? verifiedPurchasePayload(checkout, identity) : null;
      if (!purchase) return sendJson(res, 404, { error: 'Payment could not be confirmed yet.' });
      return sendJson(res, 200, purchase);
    } catch {
      // Do not leak Stripe customer data, raw provider errors or secret values.
      return sendJson(res, 503, { error: 'Payment verification is unavailable. Please try again.' });
    }
  };
}

export default createVerifyPurchaseHandler();
