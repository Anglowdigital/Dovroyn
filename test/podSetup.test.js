import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DOVROYN_POD_PRESET, MAX_BRAND_PHOTOS, validatePodSetup } from '../src/lib/podSetup.js';

test('a URL-based pod needs exactly one primary URL and one logo', () => {
  assert.match(validatePodSetup({ sourceType: 'website', sourceUrl: '', logoCount: 1, photoCount: 0 }), /primary URL/);
  assert.match(validatePodSetup({ sourceType: 'website', sourceUrl: 'https://example.com', logoCount: 0, photoCount: 0 }), /one brand logo/);
  assert.equal(validatePodSetup({ sourceType: 'website', sourceUrl: 'https://example.com', logoCount: 1, photoCount: 0 }), '');
});

test('a photos-only pod requires photos and never accepts more than five', () => {
  assert.match(validatePodSetup({ sourceType: 'photos', sourceUrl: '', logoCount: 1, photoCount: 0 }), /at least one brand photo/);
  assert.equal(validatePodSetup({ sourceType: 'photos', sourceUrl: '', logoCount: 1, photoCount: MAX_BRAND_PHOTOS }), '');
  assert.match(validatePodSetup({ sourceType: 'photos', sourceUrl: '', logoCount: 1, photoCount: MAX_BRAND_PHOTOS + 1 }), /no more than 5/);
});

test('Dovroyn can be loaded as its own website pod with the existing approved logo', () => {
  assert.equal(DOVROYN_POD_PRESET.sourceType, 'website');
  assert.equal(DOVROYN_POD_PRESET.sourceUrl, 'https://dovroyn.com');
  assert.equal(validatePodSetup({
    sourceType: DOVROYN_POD_PRESET.sourceType,
    sourceUrl: DOVROYN_POD_PRESET.sourceUrl,
    logoCount: 1,
    photoCount: 0,
  }), '');
  assert.equal(existsSync(new URL('../public/dovroyn-logo.png', import.meta.url)), true);
  const source = readFileSync(new URL('../src/pages/NewPod.jsx', import.meta.url), 'utf8');
  assert.match(source, /Load Dovroyn website/);
  assert.match(source, /fetch\(`\$\{import\.meta\.env\.BASE_URL\}dovroyn-logo\.png`\)/);
  assert.match(source, /if \(presetLoading\) \{\s*setError\('Wait for the Dovroyn logo to finish loading/);
  assert.match(source, /type="submit" disabled=\{saving \|\| presetLoading\}/);
});
