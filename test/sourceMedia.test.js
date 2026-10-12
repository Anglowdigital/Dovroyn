import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSourceMedia, fetchWebsiteText } from '../api/_lib/webSource.js';

test('own-site intake excludes fictional demo imagery and retains only the observed official logo', () => {
  assert.deepEqual(extractSourceMedia('<img src="/aurora.jpg"><img src="/hero.png"><link rel="icon" href="/dovroyn-logo.png">', 'https://dovroyn.com').map((item) => item.url), ['https://dovroyn.com/dovroyn-logo.png']);
  assert.deepEqual(extractSourceMedia('<div>No logo observed</div>', 'https://dovroyn.com'), []);
});

test('image observations are bounded, deduplicated, same-origin and pending review', () => {
  const media = extractSourceMedia('<img src="/product.webp" alt="Product"><img src="/product.webp"><img src="https://outside.test/customer.png"><img src="data:image/png,foo"><img src="/demo.png">', 'https://brand.example');
  assert.equal(media.length, 1);
  assert.equal(media[0].approval_status, 'needs_review');
  assert.equal(media[0].source_url, 'https://brand.example/');
});

test('SPA metadata fallback is observed and labelled without inventing rendered content', async () => {
  const page = await fetchWebsiteText('https://brand.example', {
    validateUrl: async (url) => new URL(url),
    fetchImpl: async () => new Response('<html><head><title>Real brand</title><meta name="description" content="Observed description"></head><body><div id="root"></div><script>Fake products</script></body></html>', { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(page.extraction_mode, 'metadata_only');
  assert.equal(page.text, 'Real brand\nObserved description');
  assert.ok(!page.text.includes('Fake'));
});
