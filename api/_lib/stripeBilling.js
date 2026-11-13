import { PLAN_ENTITLEMENTS } from '../../src/lib/plans.js';

export const CHECKOUT_SOURCE = 'dovroyn_checkout_v1';
export const BILLING_ORIGIN = 'https://dovroyn.com';

export function billingPlan(tier, billing) {
  if (typeof tier !== 'string' || !Object.hasOwn(PLAN_ENTITLEMENTS, tier)) return null;
  const plan = PLAN_ENTITLEMENTS[tier];
  if (!plan || tier === 'free' || !['monthly', 'yearly'].includes(billing)) return null;
  return { tier, billing, currency: 'aud', amount: plan[billing === 'monthly' ? 'monthlyPrice' : 'yearlyPrice'] * 100,
    interval: billing === 'monthly' ? 'month' : 'year' };
}

export function priceMatchesPlan(price, plan, { requireActive = false } = {}) {
  return Boolean(plan && price && typeof price.id === 'string' && price.id.startsWith('price_')
    && (!requireActive || price.active === true)
    && price.currency === plan.currency && price.unit_amount === plan.amount
    && price.type === 'recurring' && price.billing_scheme === 'per_unit'
    && !price.transform_quantity && !price.custom_unit_amount
    && price.recurring?.interval === plan.interval && price.recurring.interval_count === 1
    && price.recurring.usage_type === 'licensed');
}

export function singleBillingItem(collection) {
  if (collection?.has_more || collection?.data?.length !== 1) return null;
  const item = collection.data[0];
  return item?.quantity === 1 ? item : null;
}

export async function resolveCheckoutPrice(stripe, env, tier, billing) {
  const plan = billingPlan(tier, billing);
  const configured = env[`VITE_STRIPE_${String(tier).toUpperCase()}_${String(billing).toUpperCase()}`];
  if (!plan || !configured) throw new Error('Payment plan is not configured.');
  const url = new URL(configured);
  if (url.origin !== 'https://buy.stripe.com' || !/^\/[A-Za-z0-9_]+$/.test(url.pathname)
    || url.search || url.hash || url.username || url.password) throw new Error('Payment link is invalid.');
  let startingAfter;
  let link;
  for (let page = 0; page < 10; page += 1) {
    const result = await stripe.paymentLinks.list({ limit: 100, active: true, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    link = result.data?.find((entry) => entry.url === configured);
    if (link || !result.has_more) break;
    startingAfter = result.data?.at(-1)?.id;
    if (!startingAfter) break;
  }
  if (!/^(sk|rk)_(test|live)_/.test(env.STRIPE_SECRET_KEY || '')) throw new Error('Payment credentials are invalid.');
  const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY);
  if (!link?.active || link.livemode !== live) throw new Error('Payment link is unavailable.');
  const item = singleBillingItem(await stripe.paymentLinks.listLineItems(link.id, { limit: 2 }));
  if (!item?.price?.id) throw new Error('Payment plan must contain one subscription.');
  const price = await stripe.prices.retrieve(item.price.id, { expand: ['product'] });
  if (!priceMatchesPlan(price, plan, { requireActive: true }) || price.livemode !== live
    || price.product?.active !== true || price.product?.deleted) throw new Error('Payment price does not match the displayed plan.');
  return { link, price, plan };
}

export function subscriptionPeriod(subscription) {
  // Basil moved billing periods from the subscription to each subscription item.
  const item = singleBillingItem(subscription?.items);
  const start = subscription?.current_period_start ?? item?.current_period_start;
  const end = subscription?.current_period_end ?? item?.current_period_end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start) {
    throw new Error('Subscription billing period is unavailable.');
  }
  return { periodStart: start, periodEnd: end };
}

export function trustedBillingMetadata(value) {
  const m = value?.metadata;
  if (m?.source !== CHECKOUT_SOURCE) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.user_id || '')
    || !billingPlan(m.tier, m.billing) || !/^price_[A-Za-z0-9]+$/.test(m.price_id || '')) {
    throw new Error('Invalid checkout account binding.');
  }
  return m;
}
