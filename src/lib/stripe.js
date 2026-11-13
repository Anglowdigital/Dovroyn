export async function redirectToCheckout(tier, billing = 'monthly', {
  accessToken, fetchImpl = globalThis.fetch, target = globalThis.window,
} = {}) {
  if (!accessToken) throw new Error('Sign in before subscribing.');
  let response;
  let payload;
  try {
    response = await fetchImpl('/api/stripe/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ tier, billing }), cache: 'no-store',
    });
    payload = await response.json();
  } catch {
    throw new Error('Checkout could not be opened. Please try again.');
  }
  if (!response.ok) {
    const messages = {
      400: 'Choose a valid plan and billing interval.', 401: 'Sign in before subscribing.',
      409: 'You already have a subscription. Contact support@dovroyn.com to change it without starting a second subscription.',
      429: 'Please wait a minute before trying checkout again.',
      503: 'Checkout is unavailable while payment activation is being configured. Please try again or contact support@dovroyn.com.',
    };
    throw new Error(messages[response.status] || 'Checkout could not be opened. Please try again.');
  }
  let url;
  try { url = new URL(payload.url); } catch { throw new Error('Checkout could not be opened. Please try again.'); }
  if (url.origin !== 'https://checkout.stripe.com' || !url.pathname.startsWith('/c/pay/')) {
    throw new Error('Checkout could not be opened. Please try again.');
  }
  target.location.assign(url.href);
}

export { TIER_LIMITS, canCreatePod, getContentDays } from './plans.js';
