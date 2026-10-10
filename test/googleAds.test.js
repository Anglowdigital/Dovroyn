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

import { readGoogleConsent, saveGoogleConsent, rememberSignupConversion, trackConfirmedSignup } from '../src/lib/googleAds.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function browser() {
  const calls = [];
  const store = new Map();
  return {
    calls,
    gtag: (...args) => calls.push(args),
    crypto: { randomUUID: () => 'conversion-only-random-id' },
    localStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
}
const user = { id: 'private-account-id', identities: [{ id: 'identity' }], email_confirmed_at: '2026-10-10T00:00:00Z' };

test('signed-in success page without a successful registration cannot count a signup', () => {
  const target = browser();
  assert.equal(trackConfirmedSignup({ user }, 'label', target), false);
  assert.equal(rememberSignupConversion({ user: { ...user, identities: [] } }, target), false);
  assert.equal(trackConfirmedSignup({ user }, 'label', target), false);
  assert.deepEqual(target.calls, []);
});

test('confirmed signup counts once across repeated effects and page reload, without sending account identity', () => {
  const target = browser();
  assert.equal(rememberSignupConversion({ user }, target), true);
  // A reload has a fresh global object but retains browser storage.
  const reloaded = { ...target };
  assert.equal(trackConfirmedSignup({ user }, 'signup-label', reloaded), true);
  assert.equal(trackConfirmedSignup({ user }, 'signup-label', reloaded), false);
  assert.equal(trackConfirmedSignup({ user }, 'signup-label', { ...target }), false);
  assert.deepEqual(target.calls, [['event', 'conversion', {
    value: 1, currency: 'AUD', transaction_id: 'conversion-only-random-id',
    send_to: `${GOOGLE_ADS_ACCOUNT}/signup-label`,
  }]]);
});

test('unconfirmed, mismatched, or unconfigured signup keeps pending conversion unsent', () => {
  const target = browser();
  rememberSignupConversion({ user }, target);
  assert.equal(trackConfirmedSignup({ user: { ...user, email_confirmed_at: null } }, 'label', target), false);
  assert.equal(trackConfirmedSignup({ user: { ...user, id: 'other-user' } }, 'label', target), false);
  assert.equal(trackConfirmedSignup({ user }, '', target), false);
  assert.deepEqual(target.calls, []);
  assert.equal(trackConfirmedSignup({ user }, 'label', target), true);
});

test('blocked browser storage does not break consent or immediate signup', () => {
  const target = browser();
  Object.defineProperty(target, 'localStorage', { get() { throw new Error('blocked'); } });
  assert.equal(readGoogleConsent(target), null);
  saveGoogleConsent('denied', target);
  assert.equal(target.calls[0][2].ad_storage, 'denied');
  rememberSignupConversion({ user }, target);
  assert.equal(trackConfirmedSignup({ user }, 'label', target), true);
  assert.equal(trackConfirmedSignup({ user }, 'label', target), false);
});

test('tag errors, unavailable tag, and whitespace labels are safe no-ops', () => {
  assert.equal(trackGoogleAdsConversion(' ', {}, browser()), false);
  assert.equal(trackGoogleAdsConversion('label', {}, {}), false);
  assert.equal(trackGoogleAdsConversion('label', {}, { gtag() { throw new Error('blocked'); } }), false);
  const target = browser();
  trackGoogleAdsConversion(' label ', { send_to: 'wrong-account' }, target);
  assert.equal(target.calls[0][2].send_to, `${GOOGLE_ADS_ACCOUNT}/label`);
});

test('inline bootstrap restores consent before measurement and keeps denied defaults with blocked storage', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  for (const choice of ['granted', 'denied', 'invalid', null]) {
    const target = browser();
    if (choice) target.localStorage.setItem('dovroyn-google-consent-v1', choice);
    const context = { window: target };
    vm.createContext(context);
    vm.runInContext(inline, context);
    const calls = target.dataLayer.map((args) => Array.from(args));
    assert.equal(calls[0][0], 'consent');
    assert.equal(calls[0][1], 'default');
    assert.equal(calls[0][2].ad_storage, 'denied');
    const updates = calls.filter((args) => args[1] === 'update');
    assert.equal(updates.length, choice === 'granted' || choice === 'denied' ? 1 : 0);
    if (updates.length) {
      assert.equal(updates[0][2].ad_storage, choice);
      assert.ok(calls.indexOf(updates[0]) < calls.findIndex((args) => args[0] === 'config'));
    }
  }
  const target = {};
  Object.defineProperty(target, 'localStorage', { get() { throw new Error('blocked'); } });
  const context = { window: target };
  vm.createContext(context);
  vm.runInContext(inline, context);
  assert.equal(target.dataLayer[0][2].ad_storage, 'denied');
  assert.equal(target.dataLayer.at(-1)[0], 'config');
});

test('consent withdrawal synchronously denies every signal', () => {
  const target = browser();
  saveGoogleConsent('granted', target);
  saveGoogleConsent('denied', target);
  assert.deepEqual(target.calls.at(-1), ['consent', 'update', {
    ad_storage: 'denied', ad_user_data: 'denied',
    ad_personalization: 'denied', analytics_storage: 'denied',
  }]);
  assert.equal(readGoogleConsent(target), 'denied');
});

test('unavailable or failing random ID generation cannot interrupt signup', () => {
  const target = browser();
  target.crypto = { randomUUID() { throw new Error('unavailable'); } };
  assert.equal(rememberSignupConversion({ user }, target), false);
  target.crypto = undefined;
  assert.equal(rememberSignupConversion({ user }, target), false);
  assert.deepEqual(target.calls, []);
});
