export const GOOGLE_ADS_ACCOUNT = 'AW-18371036038';

const runtimeEnv = import.meta.env || {};

export const GOOGLE_ADS_SIGNUP_LABEL = runtimeEnv.VITE_GOOGLE_ADS_SIGNUP_LABEL || '';
export const GOOGLE_ADS_PURCHASE_LABEL = runtimeEnv.VITE_GOOGLE_ADS_PURCHASE_LABEL || '';

export function updateGoogleConsent(granted, target = globalThis) {
  if (typeof target?.gtag !== 'function') return false;
  const state = granted ? 'granted' : 'denied';
  target.gtag('consent', 'update', {
    ad_storage: state,
    ad_user_data: state,
    ad_personalization: state,
    analytics_storage: state,
  });
  return true;
}

export function trackGoogleAdsConversion(label, values = {}, target = globalThis) {
  if (!label || typeof target?.gtag !== 'function') return false;
  target.gtag('event', 'conversion', {
    send_to: `${GOOGLE_ADS_ACCOUNT}/${label}`,
    ...values,
  });
  return true;
}
