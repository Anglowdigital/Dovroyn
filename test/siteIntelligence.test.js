import test from 'node:test';
import assert from 'node:assert/strict';

async function loadFetcher() {
  const module = await import('../api/_lib/siteIntelligence.js').catch(() => ({}));
  assert.equal(typeof module.fetchWebsiteIntelligence, 'function', 'site intelligence fetcher must exist');
  return module.fetchWebsiteIntelligence;
}

function fakePages(pages) {
  return async (rawUrl) => {
    const url = new URL(String(rawUrl)).toString();
    const page = pages[url];
    if (page instanceof Error) throw page;
    if (!page) throw new Error(`Unexpected page fetch: ${url}`);
    return { title: '', description: '', canonicalUrl: '', h1: '', links: [], ...page };
  };
}

async function validateForTest(rawUrl) {
  const url = new URL(String(rawUrl));
  if (url.pathname === '/services') throw Object.assign(new Error('private resolution'), { status: 400 });
  return url;
}

test('site intelligence ranks useful same-origin paths, normalizes query duplicates, and labels returned pages', async () => {
  const fetchWebsiteIntelligence = await loadFetcher();
  const pages = {
    'https://brand.example/': {
      url: 'https://brand.example/',
      title: 'Brand home',
      text: 'Home evidence',
      links: [
        '/contact',
        '/blog/launch/story',
        '/about#team',
        '/products?utm_source=one',
        '/products?utm_source=two',
        '/products/widgets',
        '/pricing',
        '/cart',
        '/account/login',
        '/brochure.pdf',
        'mailto:hello@brand.example',
        'https://outside.example/products',
      ],
    },
    'https://brand.example/products': { url: 'https://brand.example/products', title: 'Products', text: 'Products evidence' },
    'https://brand.example/about': { url: 'https://brand.example/about', title: 'About', text: 'About evidence' },
    'https://brand.example/pricing': { url: 'https://brand.example/pricing', title: 'Pricing', text: 'Pricing evidence' },
    'https://brand.example/products/widgets': { url: 'https://brand.example/products/widgets', title: 'Widgets', text: 'Widget evidence' },
  };

  const intelligence = await fetchWebsiteIntelligence('https://brand.example', {
    fetchPage: fakePages(pages),
    validateUrl: async (url) => new URL(String(url)),
    maxPages: 5,
  });

  assert.deepEqual(intelligence.pages.map((page) => page.url), [
    'https://brand.example/',
    'https://brand.example/products',
    'https://brand.example/about',
    'https://brand.example/pricing',
    'https://brand.example/products/widgets',
  ]);
  assert.deepEqual(intelligence.pages.map((page) => page.sourceReference), [
    'website_home', 'website_page_2', 'website_page_3', 'website_page_4', 'website_page_5',
  ]);
  assert.ok(intelligence.pages.every((page) => new URL(page.url).origin === 'https://brand.example'));
});

test('crawl origin follows the final root URL rather than the submitted origin', async () => {
  const fetchWebsiteIntelligence = await loadFetcher();
  const intelligence = await fetchWebsiteIntelligence('https://start.example', {
    validateUrl: async (url) => new URL(String(url)),
    fetchPage: fakePages({
      'https://start.example/': {
        url: 'https://brand.example/store',
        title: 'Redirected home',
        text: 'Final home',
        links: ['https://start.example/about', '/products', 'https://brand.example/services'],
      },
      'https://brand.example/products': { url: 'https://brand.example/products', text: 'Products' },
      'https://brand.example/services': { url: 'https://brand.example/services', text: 'Services' },
    }),
  });

  assert.equal(intelligence.rootUrl, 'https://brand.example/store');
  assert.deepEqual(intelligence.pages.map((page) => page.url), [
    'https://brand.example/store',
    'https://brand.example/products',
    'https://brand.example/services',
  ]);
});

test('unreadable or privately resolved child pages are skipped without gaps in labels', async () => {
  const fetchWebsiteIntelligence = await loadFetcher();
  const intelligence = await fetchWebsiteIntelligence('https://brand.example', {
    validateUrl: validateForTest,
    fetchPage: fakePages({
      'https://brand.example/': {
        url: 'https://brand.example/',
        text: '123456',
        links: ['/products', '/services', '/about'],
      },
      'https://brand.example/products': new Error('unreadable'),
      'https://brand.example/services': { url: 'https://brand.example/services', text: 'must never be returned' },
      'https://brand.example/about': { url: 'https://brand.example/about', text: 'abcdefghij' },
    }),
    maxPages: 2,
    maxTotalChars: 10,
  });

  assert.deepEqual(intelligence.pages.map((page) => ({
    label: page.sourceReference,
    url: page.url,
    text: page.text,
  })), [
    { label: 'website_home', url: 'https://brand.example/', text: '123456' },
    { label: 'website_page_2', url: 'https://brand.example/about', text: 'abcd' },
  ]);
  assert.equal(intelligence.totalReadableChars, 10);
});

test('encoded administrative routes are excluded from returned crawl pages', async () => {
  const fetchWebsiteIntelligence = await loadFetcher();
  const intelligence = await fetchWebsiteIntelligence('https://brand.example', {
    validateUrl: async (url) => new URL(String(url)),
    fetchPage: fakePages({
      'https://brand.example/': { url: 'https://brand.example/', text: 'Home', links: ['/%61dmin', '/about'] },
      'https://brand.example/%61dmin': { url: 'https://brand.example/%61dmin', text: 'Administrative page' },
      'https://brand.example/about': { url: 'https://brand.example/about', text: 'About page' },
    }),
    maxPages: 3,
  });

  assert.deepEqual(intelligence.pages.map((page) => page.url), ['https://brand.example/', 'https://brand.example/about']);
});

test('crawl attempts stay bounded when discovered pages are unreadable', async () => {
  const fetchWebsiteIntelligence = await loadFetcher();
  let fetchCalls = 0;
  const links = Array.from({ length: 100 }, (_, index) => `/products-${String(index).padStart(3, '0')}`);
  const intelligence = await fetchWebsiteIntelligence('https://brand.example', {
    validateUrl: async (url) => new URL(String(url)),
    fetchPage: async (rawUrl) => {
      fetchCalls += 1;
      const url = new URL(String(rawUrl)).toString();
      if (url === 'https://brand.example/') return { url, text: 'Home', links, title: '', description: '', canonicalUrl: '', h1: '' };
      throw new Error('Unreadable page');
    },
  });

  assert.equal(intelligence.pages.length, 1);
  assert.ok(fetchCalls <= 13, `crawl made ${fetchCalls} page requests`);
});
