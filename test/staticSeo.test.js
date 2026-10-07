import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('robots cannot expose authenticated and auth routes as crawl targets', () => {
  const file = new URL('../public/robots.txt', import.meta.url);
  assert.ok(existsSync(file), 'robots.txt is missing');
  const robots = readFileSync(file, 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  const disallowed = [...robots.matchAll(/^Disallow: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(disallowed.sort(), ['/dashboard', '/pods', '/account', '/settings', '/login', '/signup'].sort());
  assert.match(robots, /^Sitemap: https:\/\/dovroyn\.com\/sitemap\.xml$/m);
});

test('sitemap cannot advertise private routes or omit an approved public route', () => {
  const file = new URL('../public/sitemap.xml', import.meta.url);
  assert.ok(existsSync(file), 'sitemap.xml is missing');
  const sitemap = readFileSync(file, 'utf8');
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, [
    'https://dovroyn.com/', 'https://dovroyn.com/pricing', 'https://dovroyn.com/demo-pod',
    'https://dovroyn.com/privacy', 'https://dovroyn.com/terms', 'https://dovroyn.com/contact',
  ]);
});

test('static homepage metadata cannot omit canonical indexability or alter theme colour', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="canonical" href="https:\/\/dovroyn\.com\/"\s*\/>/);
  assert.match(html, /<meta name="robots" content="index, follow"\s*\/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/dovroyn\.com\/"\s*\/>/);
  assert.match(html, /<meta name="theme-color" content="#07162D"\s*\/>/);
});

test('Google Ads tag loads once and configures the approved conversion account', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const tagUrl = 'https://www.googletagmanager.com/gtag/js?id=AW-18371036038';
  assert.equal(html.split(tagUrl).length - 1, 1);
  assert.match(html, /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=AW-18371036038"><\/script>/);
  assert.match(html, /window\.dataLayer = window\.dataLayer \|\| \[\];/);
  assert.match(html, /function gtag\(\) \{ window\.dataLayer\.push\(arguments\); \}/);
  assert.match(html, /gtag\('config', 'AW-18371036038'\);/);
});

test('Google consent defaults are denied before the Ads configuration fires', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const consentIndex = html.indexOf("gtag('consent', 'default'");
  const configIndex = html.indexOf("gtag('config', 'AW-18371036038')");
  assert.ok(consentIndex >= 0, 'Google consent default is missing');
  assert.ok(consentIndex < configIndex, 'Google consent must be set before Ads config');
  for (const field of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage']) {
    assert.match(html, new RegExp(`'${field}': 'denied'`));
  }
});

test('privacy copy discloses Google Ads conversion measurement', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /Google Ads conversion measurement/);
  assert.match(source, /Google \(advertising measurement\)/);
  assert.match(source, /Last updated: October 2026/);
  assert.match(source, /consent choice/);
});

test('live contact route cannot depend on the retired waitlist', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /supabase\.from\('waitlist'\)/);
  assert.match(source, /href="mailto:support@dovroyn\.com\?subject=Dovroyn%20enquiry"/);
  assert.match(source, /Contact us by email/);
});

test('public app offers an explicit Google measurement consent choice', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /GoogleConsentBanner/);
  assert.match(source, /Accept analytics/);
  assert.match(source, /Decline/);
});

test('successful account creation has a dedicated Google Ads confirmation route', () => {
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /Route path="\/signup-success"/);
  assert.match(source, /emailRedirectTo: `\$\{window\.location\.origin\}\/signup-success`/);
  assert.match(source, /navigate\('\/signup-success', \{ replace: true \}\)/);
  assert.match(source, /Account created/);
});
