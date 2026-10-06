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
