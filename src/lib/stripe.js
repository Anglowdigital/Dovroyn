// Stripe checkout helper
// Redirects user to Stripe Checkout for subscription

const STRIPE_PRICING_LINKS = {
  starter_monthly: import.meta.env.VITE_STRIPE_STARTER_MONTHLY || null,
  starter_yearly: import.meta.env.VITE_STRIPE_STARTER_YEARLY || null,
  growth_monthly: import.meta.env.VITE_STRIPE_GROWTH_MONTHLY || null,
  growth_yearly: import.meta.env.VITE_STRIPE_GROWTH_YEARLY || null,
  pro_monthly: import.meta.env.VITE_STRIPE_PRO_MONTHLY || null,
  pro_yearly: import.meta.env.VITE_STRIPE_PRO_YEARLY || null,
  scale_monthly: import.meta.env.VITE_STRIPE_SCALE_MONTHLY || null,
  scale_yearly: import.meta.env.VITE_STRIPE_SCALE_YEARLY || null,
};

export function getCheckoutUrl(tierKey, billing = 'monthly') {
  const key = `${tierKey}_${billing}`;
  return STRIPE_PRICING_LINKS[key] || null;
}

export function redirectToCheckout(tierKey, billing = 'monthly', { onUnavailable } = {}) {
  const url = getCheckoutUrl(tierKey, billing);
  if (url) {
    window.location.href = url;
  } else if (onUnavailable) {
    // Signed-in users see an inline notice instead of being bounced to signup.
    onUnavailable();
  } else {
    // Let logged-out visitors create an account when a checkout link is not configured.
    window.location.href = '/signup';
  }
}

export { TIER_LIMITS, canCreatePod, getContentDays } from './plans.js';
