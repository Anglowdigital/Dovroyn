export const GOOGLE_ADS_ACCOUNT = 'AW-18371036038';

const runtimeEnv = import.meta.env || {};

export const GOOGLE_ADS_SIGNUP_LABEL = runtimeEnv.VITE_GOOGLE_ADS_SIGNUP_LABEL || '';
export const GOOGLE_ADS_PURCHASE_LABEL = runtimeEnv.VITE_GOOGLE_ADS_PURCHASE_LABEL || '';
export const GOOGLE_CONSENT_KEY = 'dovroyn-google-consent-v1';
const PENDING_SIGNUP_KEY = 'dovroyn-pending-signup-conversion-v1';
const pendingByTarget = new WeakMap();

export function readGoogleConsent(target = globalThis) {
  try { return target.localStorage?.getItem(GOOGLE_CONSENT_KEY) || null; }
  catch { return null; }
}

export function saveGoogleConsent(choice, target = globalThis) {
  // Update synchronously, before any navigation; storage is optional.
  updateGoogleConsent(choice === 'granted', target);
  try { target.localStorage?.setItem(GOOGLE_CONSENT_KEY, choice); } catch { /* blocked storage */ }
}

export function rememberSignupConversion(data, target = globalThis) {
  // Supabase can obscure an existing account with a user containing no identities.
  if (!data?.user?.id || !data.user.identities?.length) return false;
  let transactionId;
  try { transactionId = target.crypto?.randomUUID?.(); } catch { return false; }
  if (!transactionId) return false;
  const pending = { userId: data.user.id, transactionId };
  pendingByTarget.set(target, pending);
  try { target.localStorage?.setItem(PENDING_SIGNUP_KEY, JSON.stringify(pending)); } catch { /* use memory */ }
  return true;
}

export function trackConfirmedSignup(session, label = GOOGLE_ADS_SIGNUP_LABEL, target = globalThis) {
  if (!session?.user?.id || !session.user.email_confirmed_at) return false;
  let pending = pendingByTarget.get(target);
  if (!pending) {
    try { pending = JSON.parse(target.localStorage?.getItem(PENDING_SIGNUP_KEY) || 'null'); }
    catch { return false; }
  }
  if (pending?.userId !== session.user.id || !pending?.transactionId) return false;
  const sent = trackGoogleAdsConversion(label, {
    value: 1, currency: 'AUD', transaction_id: pending.transactionId,
  }, target);
  if (sent) {
    pendingByTarget.delete(target);
    try { target.localStorage?.removeItem(PENDING_SIGNUP_KEY); } catch { /* Google also deduplicates by transaction ID */ }
  }
  return sent;
}

export function updateGoogleConsent(granted, target = globalThis) {
  if (typeof target?.gtag !== 'function') return false;
  const state = granted ? 'granted' : 'denied';
  try {
    target.gtag('consent', 'update', {
      ad_storage: state,
      ad_user_data: state,
      ad_personalization: state,
      analytics_storage: state,
    });
  } catch { return false; }
  return true;
}

export function trackGoogleAdsConversion(label, values = {}, target = globalThis) {
  const normalizedLabel = typeof label === 'string' ? label.trim() : '';
  if (!normalizedLabel || typeof target?.gtag !== 'function') return false;
  try {
    target.gtag('event', 'conversion', {
      ...values,
      send_to: `${GOOGLE_ADS_ACCOUNT}/${normalizedLabel}`,
    });
  } catch { return false; }
  return true;
}
