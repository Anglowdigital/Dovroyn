import { GOOGLE_ADS_PURCHASE_LABEL, trackGoogleAdsConversion } from './googleAds.js';

const sentByTarget = new WeakMap();

function validCheckoutReference(value) {
  return typeof value === 'string' && value.length <= 255 && /^cs_live_[A-Za-z0-9]+$/.test(value);
}

export function purchaseLoginPath(sessionId) {
  return validCheckoutReference(sessionId) ? `/login?purchase_session_id=${encodeURIComponent(sessionId)}` : '/login';
}

export function purchaseReturnPath(search) {
  const sessionId = new URLSearchParams(search).get('purchase_session_id');
  return validCheckoutReference(sessionId) ? `/purchase-success?session_id=${encodeURIComponent(sessionId)}` : '/dashboard';
}

export function isVerifiedPurchase(purchase) {
  return purchase?.verified === true && /^[a-f0-9]{64}$/.test(purchase.transaction_id || '')
    && Number.isFinite(purchase.value) && purchase.value > 0 && purchase.currency === 'AUD';
}

export async function verifyPurchase(sessionId, accessToken, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/stripe/verify-purchase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ sessionId }),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !isVerifiedPurchase(payload)) throw new Error('Your payment could not be confirmed yet. Please check your receipt or try again.');
  return payload;
}

export function trackVerifiedPurchase(purchase, label = GOOGLE_ADS_PURCHASE_LABEL, target = globalThis) {
  if (!isVerifiedPurchase(purchase)) return false;
  const key = `dovroyn-purchase-conversion-v1:${purchase.transaction_id}`;
  const sent = sentByTarget.get(target) || new Set();
  if (sent.has(key)) return false;
  try { if (target.localStorage?.getItem(key) === 'sent') return false; } catch { /* use memory */ }
  const queued = trackGoogleAdsConversion(label, {
    value: purchase.value, currency: purchase.currency, transaction_id: purchase.transaction_id,
  }, target);
  if (queued) {
    sent.add(key);
    sentByTarget.set(target, sent);
    try { target.localStorage?.setItem(key, 'sent'); } catch { /* Google also deduplicates by transaction ID */ }
  }
  return queued;
}
