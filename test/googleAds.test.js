import test from 'node:test';
import assert from 'node:assert/strict';

import { GOOGLE_ADS_ACCOUNT, trackGoogleAdsConversion, updateGoogleConsent } from '../src/lib/googleAds.js';

test('consent update sends all four Google consent signals', () => {
  const calls = [];
  updateGoogleConsent(true, { gtag: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[
    'consent',
    'update',
    {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted',
    },
  ]]);
});

test('conversion event is a safe no-op until Google supplies a label', () => {
  const calls = [];
  assert.equal(trackGoogleAdsConversion('', {}, { gtag: (...args) => calls.push(args) }), false);
  assert.deepEqual(calls, []);
});

test('conversion event targets the approved Ads account and label', () => {
  const calls = [];
  assert.equal(trackGoogleAdsConversion('signup-label', { value: 1 }, { gtag: (...args) => calls.push(args) }), true);
  assert.deepEqual(calls, [[
    'event',
    'conversion',
    { send_to: `${GOOGLE_ADS_ACCOUNT}/signup-label`, value: 1 },
  ]]);
});
